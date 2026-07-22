import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIFECYCLE_POLICY } from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { type Db, migrateDb, openDb } from './db/db';
import { createSandbox, findByName, transition } from './db/ledger';
import type { SandboxRow } from './db/schema';
import { WatcherTable } from './e2b/watcher-table';
import { FakeExecutor } from './executor/fake';
import { KeyedQueue } from './keyed-queue';
import { reconcile } from './reconciler';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

const NONE = {
  repairedStates: 0,
  deletedRows: 0,
  destroyedOrphans: 0,
  removedDisks: 0,
  archivedSwept: 0,
  suspects: [],
};

function setup() {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  return { db, executor: new FakeExecutor(), locks: new KeyedQueue() };
}

/**
 * A healthy sandbox: container running, row active. Drift is then staged by
 * calling the executor or the ledger directly — exactly the one-sided moves
 * a crash between "reality first" and "ledger second" leaves behind.
 */
async function seed(
  db: Db,
  executor: FakeExecutor,
  name: string,
): Promise<SandboxRow> {
  const id = randomUUID();
  await executor.create(id);
  return createSandbox(db, {
    id,
    name,
    nodeId: 'node-test',
    policy: DEFAULT_LIFECYCLE_POLICY,
  });
}

describe('startup reconcile', () => {
  it('touches nothing when ledger and reality agree', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    expect(await reconcile(db, executor, locks)).toEqual(NONE);
    expect(findByName(db, 'alice')?.state).toBe('active');
    expect(executor.stateOf(row.id)).toBe('running');
  });

  it('records a freeze the ledger missed', async () => {
    const { db, executor, locks } = setup();
    // Crash between executor.freeze() and transition(): reality moved alone.
    const row = await seed(db, executor, 'alice');
    await executor.freeze(row.id);

    const result = await reconcile(db, executor, locks);
    expect(result).toEqual({ ...NONE, repairedStates: 1 });
    expect(findByName(db, 'alice')?.state).toBe('frozen');
  });

  it('repairs across rungs and drops ownership when reality is stopped', async () => {
    const { db, executor, locks } = setup();
    // Ledger says active, container is fully stopped — a two-rung gap that
    // transition() would reject. The reconciler records facts, not moves.
    const row = await seed(db, executor, 'alice');
    const watchers = new WatcherTable();
    await watchers.create({
      executor,
      sandboxId: row.id,
      path: '/home/user',
      recursive: false,
    });
    await executor.freeze(row.id);
    await executor.stop(row.id);

    const result = await reconcile(
      db,
      executor,
      locks,
      undefined,
      undefined,
      watchers,
    );
    expect(result).toEqual({ ...NONE, repairedStates: 1 });
    expect(findByName(db, 'alice')?.state).toBe('stopped');
    expect(watchers.count(row.id)).toBe(0);
  });

  it('keeps the row of a pruned container: the disk is the sandbox', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    // The container object is removed behind the daemon's back (a routine
    // `docker container prune` does this to every exited container) while
    // the disk — the sandbox's actual data — stays.
    executor.vanishContainer(row.id);

    const result = await reconcile(db, executor, locks);
    // Not a death: the sandbox is recorded as stopped, its row keeps the
    // name, and the next acquire rebuilds the container from the disk.
    expect(result).toEqual({ ...NONE, repairedStates: 1 });
    expect(findByName(db, 'alice')?.state).toBe('stopped');
    expect(await executor.listDisks()).toContain(row.id);
  });

  it('deletes the row only when container and disk are both gone', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    // The end state of a release that crashed after the executor's work but
    // before the ledger's delete: nothing of the sandbox physically remains.
    executor.vanishContainer(row.id);
    await executor.removeDisk(row.id);

    const result = await reconcile(db, executor, locks);
    expect(result).toEqual({ ...NONE, deletedRows: 1 });
    expect(findByName(db, 'alice')).toBeUndefined();
  });

  it('destroys a container no row points at', async () => {
    const { db, executor, locks } = setup();
    // Crash between executor.create() and createSandbox(): a container was
    // born but never entered the ledger, so no name can ever reach it.
    await executor.create('orphan');

    const result = await reconcile(db, executor, locks);
    expect(result).toEqual({ ...NONE, destroyedOrphans: 1 });
    expect(executor.stateOf('orphan')).toBeUndefined();
  });

  it('sweeps the stale local copy of an archived row', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    // A crash between the archive's ledger write and its local cleanup:
    // the transition to archived IS the upload confirmation, so whatever is
    // still here is a stale copy — the sweep resumes the interrupted job.
    await executor.freeze(row.id);
    await executor.stop(row.id);
    transition(db, row.id, 'frozen');
    transition(db, row.id, 'stopped');
    transition(db, row.id, 'archived');

    expect(await reconcile(db, executor, locks)).toEqual({
      ...NONE,
      archivedSwept: 1,
    });
    expect(findByName(db, 'alice')?.state).toBe('archived');
    expect(executor.stateOf(row.id)).toBeUndefined();
    expect(await executor.listDisks()).not.toContain(row.id);
  });

  it('sweeps an archived row whose container is gone but disk remains', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    await executor.freeze(row.id);
    await executor.stop(row.id);
    transition(db, row.id, 'frozen');
    transition(db, row.id, 'stopped');
    transition(db, row.id, 'archived');
    executor.vanishContainer(row.id);

    expect(await reconcile(db, executor, locks)).toEqual({
      ...NONE,
      archivedSwept: 1,
    });
    expect(findByName(db, 'alice')?.state).toBe('archived');
    expect(await executor.listDisks()).not.toContain(row.id);
  });

  it('leaves a fully-archived row alone — its body is in S3', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    await executor.freeze(row.id);
    await executor.stop(row.id);
    transition(db, row.id, 'frozen');
    transition(db, row.id, 'stopped');
    transition(db, row.id, 'archived');
    await executor.destroy(row.id);

    // Nothing local, and crucially NOT deletedRows: an archived row with no
    // local remains is the normal state, not drift.
    expect(await reconcile(db, executor, locks)).toEqual(NONE);
    expect(findByName(db, 'alice')?.state).toBe('archived');
  });

  it('reverts a restoring zombie with no live task to archived', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    // A crash mid-restore: the row says restoring, a half-extracted disk
    // exists, no container yet — and the tracker (daemon memory) is empty.
    await executor.freeze(row.id);
    await executor.stop(row.id);
    transition(db, row.id, 'frozen');
    transition(db, row.id, 'stopped');
    transition(db, row.id, 'archived');
    await executor.destroy(row.id);
    executor.plantDiskResidue(row.id);
    transition(db, row.id, 'restoring');

    const result = await reconcile(db, executor, locks);
    // The disk is the task's garbage; the S3 object is intact, so archived
    // makes the next acquire a clean retry.
    expect(result).toEqual({ ...NONE, repairedStates: 1 });
    expect(findByName(db, 'alice')?.state).toBe('archived');
    expect(await executor.listDisks()).not.toContain(row.id);
  });

  it('records a restoring zombie whose container runs as active', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    // A crash between the restore's start() and its ledger write: the
    // restore physically finished. Reality wins — removing the disk under
    // a live container would be the ledger trashing reality.
    await executor.freeze(row.id);
    await executor.stop(row.id);
    transition(db, row.id, 'frozen');
    transition(db, row.id, 'stopped');
    transition(db, row.id, 'archived');
    transition(db, row.id, 'restoring');
    await executor.start(row.id);

    const result = await reconcile(db, executor, locks);
    expect(result).toEqual({ ...NONE, repairedStates: 1 });
    expect(findByName(db, 'alice')?.state).toBe('active');
    expect(executor.stateOf(row.id)).toBe('running');
  });

  it('leaves a restoring row with a live task untouched', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    await executor.freeze(row.id);
    await executor.stop(row.id);
    transition(db, row.id, 'frozen');
    transition(db, row.id, 'stopped');
    transition(db, row.id, 'archived');
    await executor.destroy(row.id);
    // Mid-restore: the task has built half a disk and is still running.
    executor.plantDiskResidue(row.id);
    transition(db, row.id, 'restoring');

    const result = await reconcile(db, executor, locks, new Set(), {
      hasLiveRestore: () => true,
    });
    expect(result).toEqual(NONE);
    expect(findByName(db, 'alice')?.state).toBe('restoring');
    // The mid-flight disk also dodges the orphan pass: the row owns it.
    expect(await executor.listDisks()).toContain(row.id);
  });

  it('repairs every sandbox in one pass', async () => {
    const { db, executor, locks } = setup();
    const healthy = await seed(db, executor, 'healthy');
    const drifted = await seed(db, executor, 'drifted');
    const pruned = await seed(db, executor, 'pruned');
    const dead = await seed(db, executor, 'dead');
    await executor.freeze(drifted.id);
    executor.vanishContainer(pruned.id);
    executor.vanishContainer(dead.id);
    await executor.removeDisk(dead.id);
    await executor.create('orphan');

    expect(await reconcile(db, executor, locks)).toEqual({
      // drifted -> frozen, pruned -> stopped (its disk keeps it alive).
      repairedStates: 2,
      deletedRows: 1,
      destroyedOrphans: 1,
      removedDisks: 0,
      archivedSwept: 0,
      suspects: [],
    });
    expect(findByName(db, 'healthy')?.state).toBe('active');
    expect(findByName(db, 'drifted')?.state).toBe('frozen');
    expect(findByName(db, 'pruned')?.state).toBe('stopped');
    expect(findByName(db, 'dead')).toBeUndefined();
    expect(executor.stateOf(healthy.id)).toBe('running');
    expect(executor.stateOf('orphan')).toBeUndefined();
  });
});

describe('runtime reconcile (two-strike orphans)', () => {
  it('only suspects a first-time orphan, destroys it on the second pass', async () => {
    const { db, executor, locks } = setup();
    // At runtime this container could be an acquire still in flight — its
    // row lands right after create returns. Killing it on sight would
    // sabotage the very request creating it.
    await executor.create('maybe-in-flight');

    const first = await reconcile(db, executor, locks, new Set());
    expect(first).toEqual({ ...NONE, suspects: ['maybe-in-flight'] });
    expect(executor.stateOf('maybe-in-flight')).toBe('running');

    // Still no row one interval later: genuinely unreachable, put it down.
    const second = await reconcile(
      db,
      executor,
      locks,
      new Set(first.suspects),
    );
    expect(second).toEqual({ ...NONE, destroyedOrphans: 1 });
    expect(executor.stateOf('maybe-in-flight')).toBeUndefined();
  });

  it('clears a suspect whose row landed in the meantime', async () => {
    const { db, executor, locks } = setup();
    await executor.create('in-flight');
    const first = await reconcile(db, executor, locks, new Set());
    expect(first.suspects).toEqual(['in-flight']);

    // The acquire finished: the row is in the ledger now.
    createSandbox(db, {
      id: 'in-flight',
      name: 'alice',
      nodeId: 'node-test',
      policy: DEFAULT_LIFECYCLE_POLICY,
    });

    const second = await reconcile(
      db,
      executor,
      locks,
      new Set(first.suspects),
    );
    expect(second).toEqual(NONE);
    expect(executor.stateOf('in-flight')).toBe('running');
    expect(findByName(db, 'alice')?.state).toBe('active');
  });

  it('still repairs and buries on every runtime pass, not only at boot', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    executor.vanishContainer(row.id);
    await executor.removeDisk(row.id);

    const result = await reconcile(db, executor, locks, new Set());
    expect(result).toEqual({ ...NONE, deletedRows: 1 });
    expect(findByName(db, 'alice')).toBeUndefined();
  });

  it('skips a row whose key is busy instead of repairing from a stale view', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    // Reality drifted (paused, ledger says active)...
    await executor.freeze(row.id);
    // ...but alice's slot is held — an acquire or release is mid-operation
    // and knows more about this sandbox than our snapshot does.
    let release!: () => void;
    const holder = locks.run(
      'alice',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const result = await reconcile(db, executor, locks, new Set());
    expect(result.repairedStates).toBe(0);
    expect(findByName(db, 'alice')?.state).toBe('active');

    release();
    await holder;
    // Next tick, with the key free, the repair lands.
    const next = await reconcile(db, executor, locks, new Set());
    expect(next).toEqual({ ...NONE, repairedStates: 1 });
    expect(findByName(db, 'alice')?.state).toBe('frozen');
  });
});

describe('disk reconcile', () => {
  it('leaves the disks of living sandboxes alone', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    expect(await reconcile(db, executor, locks, new Set())).toEqual(NONE);
    expect(await executor.listDisks()).toContain(row.id);
  });

  it('removes a disk nothing owns on two strikes at runtime', async () => {
    const { db, executor, locks } = setup();
    // Crash between provisioning the disk and creating the container.
    executor.plantDiskResidue('half-created');

    const first = await reconcile(db, executor, locks, new Set());
    expect(first).toEqual({ ...NONE, suspects: ['half-created'] });
    expect(await executor.listDisks()).toContain('half-created');

    const second = await reconcile(
      db,
      executor,
      locks,
      new Set(first.suspects),
    );
    expect(second).toEqual({ ...NONE, removedDisks: 1 });
    expect(await executor.listDisks()).not.toContain('half-created');
  });

  it('removes unowned disks immediately at startup', async () => {
    const { db, executor, locks } = setup();
    executor.plantDiskResidue('leftover');
    expect(await reconcile(db, executor, locks)).toEqual({
      ...NONE,
      removedDisks: 1,
    });
    expect(await executor.listDisks()).not.toContain('leftover');
  });

  it('protects the disk of a suspected orphan container', async () => {
    const { db, executor, locks } = setup();
    // An acquire possibly still in flight: container and disk, no row yet.
    await executor.create('maybe-in-flight');

    const first = await reconcile(db, executor, locks, new Set());
    // Suspected once, as a container — not doubly as its disk.
    expect(first.suspects).toEqual(['maybe-in-flight']);
    expect(await executor.listDisks()).toContain('maybe-in-flight');

    // Second strike: destroy takes container and disk down together.
    const second = await reconcile(
      db,
      executor,
      locks,
      new Set(first.suspects),
    );
    expect(second).toEqual({ ...NONE, destroyedOrphans: 1 });
    expect(await executor.listDisks()).not.toContain('maybe-in-flight');
  });
});
