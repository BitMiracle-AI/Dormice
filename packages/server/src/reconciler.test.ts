import { randomUUID } from 'node:crypto';
import { DEFAULT_LIFECYCLE_POLICY } from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { type Db, migrateDb, openDb } from './db/db';
import { createSandbox, findByUserKey, transition } from './db/ledger';
import type { SandboxRow } from './db/schema';
import { FakeExecutor } from './executor/fake';
import { reconcile } from './reconciler';

const MIGRATIONS = new URL('../drizzle', import.meta.url).pathname;

const NONE = {
  repairedStates: 0,
  deletedRows: 0,
  destroyedOrphans: 0,
  suspects: [],
};

function setup() {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  return { db, executor: new FakeExecutor() };
}

/**
 * A healthy sandbox: container running, row active. Drift is then staged by
 * calling the executor or the ledger directly — exactly the one-sided moves
 * a crash between "reality first" and "ledger second" leaves behind.
 */
async function seed(
  db: Db,
  executor: FakeExecutor,
  userKey: string,
): Promise<SandboxRow> {
  const sandboxId = randomUUID();
  await executor.create(sandboxId);
  return createSandbox(db, {
    sandboxId,
    userKey,
    nodeId: 'node-test',
    policy: DEFAULT_LIFECYCLE_POLICY,
  });
}

describe('startup reconcile', () => {
  it('touches nothing when ledger and reality agree', async () => {
    const { db, executor } = setup();
    const row = await seed(db, executor, 'alice');
    expect(await reconcile(db, executor)).toEqual(NONE);
    expect(findByUserKey(db, 'alice')?.state).toBe('active');
    expect(executor.stateOf(row.sandboxId)).toBe('running');
  });

  it('records a freeze the ledger missed', async () => {
    const { db, executor } = setup();
    // Crash between executor.freeze() and transition(): reality moved alone.
    const row = await seed(db, executor, 'alice');
    await executor.freeze(row.sandboxId);

    const result = await reconcile(db, executor);
    expect(result).toEqual({ ...NONE, repairedStates: 1 });
    expect(findByUserKey(db, 'alice')?.state).toBe('frozen');
  });

  it('repairs across rungs the transition table would forbid', async () => {
    const { db, executor } = setup();
    // Ledger says active, container is fully stopped — a two-rung gap that
    // transition() would reject. The reconciler records facts, not moves.
    const row = await seed(db, executor, 'alice');
    await executor.freeze(row.sandboxId);
    await executor.stop(row.sandboxId);

    const result = await reconcile(db, executor);
    expect(result).toEqual({ ...NONE, repairedStates: 1 });
    expect(findByUserKey(db, 'alice')?.state).toBe('stopped');
  });

  it('deletes the row of a vanished container, freeing the user key', async () => {
    const { db, executor } = setup();
    const row = await seed(db, executor, 'alice');
    // gVisor kills the whole box on OOM; to the daemon it simply vanished.
    await executor.destroy(row.sandboxId);

    const result = await reconcile(db, executor);
    expect(result).toEqual({ ...NONE, deletedRows: 1 });
    expect(findByUserKey(db, 'alice')).toBeUndefined();
  });

  it('destroys a container no row points at', async () => {
    const { db, executor } = setup();
    // Crash between executor.create() and createSandbox(): a container was
    // born but never entered the ledger, so no user key can ever reach it.
    await executor.create('orphan');

    const result = await reconcile(db, executor);
    expect(result).toEqual({ ...NONE, destroyedOrphans: 1 });
    expect(executor.stateOf('orphan')).toBeUndefined();
  });

  it('leaves archived rows to the future archiver', async () => {
    const { db, executor } = setup();
    const row = await seed(db, executor, 'alice');
    // Walk the legal path to archived; the container is still around, but
    // judging that is the archiver's reconciliation, not this one's.
    await executor.freeze(row.sandboxId);
    await executor.stop(row.sandboxId);
    transition(db, row.sandboxId, 'frozen');
    transition(db, row.sandboxId, 'stopped');
    transition(db, row.sandboxId, 'archived');

    expect(await reconcile(db, executor)).toEqual(NONE);
    expect(findByUserKey(db, 'alice')?.state).toBe('archived');
    expect(executor.stateOf(row.sandboxId)).toBe('stopped');
  });

  it('repairs every sandbox in one pass', async () => {
    const { db, executor } = setup();
    const healthy = await seed(db, executor, 'healthy');
    const drifted = await seed(db, executor, 'drifted');
    const vanished = await seed(db, executor, 'vanished');
    await executor.freeze(drifted.sandboxId);
    await executor.destroy(vanished.sandboxId);
    await executor.create('orphan');

    expect(await reconcile(db, executor)).toEqual({
      repairedStates: 1,
      deletedRows: 1,
      destroyedOrphans: 1,
      suspects: [],
    });
    expect(findByUserKey(db, 'healthy')?.state).toBe('active');
    expect(findByUserKey(db, 'drifted')?.state).toBe('frozen');
    expect(findByUserKey(db, 'vanished')).toBeUndefined();
    expect(executor.stateOf(healthy.sandboxId)).toBe('running');
    expect(executor.stateOf('orphan')).toBeUndefined();
  });
});

describe('runtime reconcile (two-strike orphans)', () => {
  it('only suspects a first-time orphan, destroys it on the second pass', async () => {
    const { db, executor } = setup();
    // At runtime this container could be an acquire still in flight — its
    // row lands right after create returns. Killing it on sight would
    // sabotage the very request creating it.
    await executor.create('maybe-in-flight');

    const first = await reconcile(db, executor, new Set());
    expect(first).toEqual({ ...NONE, suspects: ['maybe-in-flight'] });
    expect(executor.stateOf('maybe-in-flight')).toBe('running');

    // Still no row one interval later: genuinely unreachable, put it down.
    const second = await reconcile(db, executor, new Set(first.suspects));
    expect(second).toEqual({ ...NONE, destroyedOrphans: 1 });
    expect(executor.stateOf('maybe-in-flight')).toBeUndefined();
  });

  it('clears a suspect whose row landed in the meantime', async () => {
    const { db, executor } = setup();
    await executor.create('in-flight');
    const first = await reconcile(db, executor, new Set());
    expect(first.suspects).toEqual(['in-flight']);

    // The acquire finished: the row is in the ledger now.
    createSandbox(db, {
      sandboxId: 'in-flight',
      userKey: 'alice',
      nodeId: 'node-test',
      policy: DEFAULT_LIFECYCLE_POLICY,
    });

    const second = await reconcile(db, executor, new Set(first.suspects));
    expect(second).toEqual(NONE);
    expect(executor.stateOf('in-flight')).toBe('running');
    expect(findByUserKey(db, 'alice')?.state).toBe('active');
  });

  it('still repairs rows and deletes the dead on every runtime pass', async () => {
    const { db, executor } = setup();
    const row = await seed(db, executor, 'alice');
    await executor.destroy(row.sandboxId);

    const result = await reconcile(db, executor, new Set());
    expect(result).toEqual({ ...NONE, deletedRows: 1 });
    expect(findByUserKey(db, 'alice')).toBeUndefined();
  });
});
