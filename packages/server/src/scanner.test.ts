import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIFECYCLE_POLICY,
  type LifecyclePolicy,
} from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { Archiver } from './archive/archiver';
import { MemStore } from './archive/mem-store';
import { objectKey } from './archive/store';
import { type Db, migrateDb, openDb } from './db/db';
import { createSandbox, findByExternalId, setDeadline, touch } from './db/ledger';
import type { SandboxRow } from './db/schema';
import { FakeExecutor } from './executor/fake';
import { KeyedQueue } from './keyed-queue';
import { destroySandbox } from './lifecycle';
import { scanOnce } from './scanner';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

function setup() {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  return { db, executor: new FakeExecutor(), locks: new KeyedQueue() };
}

/** The archive-enabled flavor: same setup plus a MemStore-backed archiver. */
function setupWithArchiver() {
  const base = setup();
  const store = new MemStore();
  const archiver = new Archiver({
    ...base,
    store,
    tmpDir: mkdtempSync(path.join(tmpdir(), 'dormice-scan-')),
  });
  return { ...base, store, archiver };
}

async function seed(
  db: Db,
  executor: FakeExecutor,
  externalId: string,
  policy: LifecyclePolicy = DEFAULT_LIFECYCLE_POLICY,
): Promise<SandboxRow> {
  const sandboxId = randomUUID();
  await executor.create(sandboxId);
  return createSandbox(db, { sandboxId, externalId, nodeId: 'node-test', policy });
}

/** Time travel: the instant `seconds` after the row's last activity. */
function after(row: SandboxRow, seconds: number): Date {
  return new Date(Date.parse(row.lastActiveAt) + seconds * 1000);
}

describe('idle scanner', () => {
  it('leaves sandboxes alone below the freeze threshold', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    const result = await scanOnce(db, executor, locks, after(row, 1));
    expect(result).toEqual({
      frozen: 0,
      stopped: 0,
      archived: 0,
      expiredKilled: 0,
      failures: [],
    });
    expect(findByExternalId(db, 'alice')?.state).toBe('active');
    expect(executor.stateOf(row.sandboxId)).toBe('running');
  });

  it('freezes a sandbox idle past freezeAfterSeconds', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    const result = await scanOnce(
      db,
      executor,
      locks,
      after(row, row.freezeAfterSeconds),
    );
    expect(result).toEqual({
      frozen: 1,
      stopped: 0,
      archived: 0,
      expiredKilled: 0,
      failures: [],
    });
    expect(findByExternalId(db, 'alice')?.state).toBe('frozen');
    expect(executor.stateOf(row.sandboxId)).toBe('paused');
  });

  it('stops a frozen sandbox idle past stopAfterSeconds', async () => {
    const { db, executor, locks } = setup();
    // Explicit thresholds: the type of stopAfterSeconds is nullable now.
    const row = await seed(db, executor, 'alice', {
      ...DEFAULT_LIFECYCLE_POLICY,
      freezeAfterSeconds: 60,
      stopAfterSeconds: 120,
    });
    await scanOnce(db, executor, locks, after(row, 60));
    const result = await scanOnce(db, executor, locks, after(row, 120));
    expect(result).toEqual({
      frozen: 0,
      stopped: 1,
      archived: 0,
      expiredKilled: 0,
      failures: [],
    });
    expect(findByExternalId(db, 'alice')?.state).toBe('stopped');
    expect(executor.stateOf(row.sandboxId)).toBe('stopped');
  });

  it('moves one rung per sweep, even for a long-dead sandbox', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    const yearLater = after(row, 365 * 24 * 60 * 60);
    expect(await scanOnce(db, executor, locks, yearLater)).toEqual({
      frozen: 1,
      stopped: 0,
      archived: 0,
      expiredKilled: 0,
      failures: [],
    });
    expect(findByExternalId(db, 'alice')?.state).toBe('frozen');
    expect(await scanOnce(db, executor, locks, yearLater)).toEqual({
      frozen: 0,
      stopped: 1,
      archived: 0,
      expiredKilled: 0,
      failures: [],
    });
    expect(findByExternalId(db, 'alice')?.state).toBe('stopped');
  });

  it('applies each sandbox its own policy', async () => {
    const { db, executor, locks } = setup();
    const quick = await seed(db, executor, 'quick', {
      ...DEFAULT_LIFECYCLE_POLICY,
      freezeAfterSeconds: 60,
    });
    const slow = await seed(db, executor, 'slow');
    const result = await scanOnce(db, executor, locks, after(quick, 100));
    expect(result).toEqual({
      frozen: 1,
      stopped: 0,
      archived: 0,
      expiredKilled: 0,
      failures: [],
    });
    expect(findByExternalId(db, 'quick')?.state).toBe('frozen');
    expect(findByExternalId(db, 'slow')?.state).toBe('active');
    expect(executor.stateOf(slow.sandboxId)).toBe('running');
  });

  it('never stops a frozen sandbox whose policy says stop: null', async () => {
    const { db, executor, locks } = setup();
    // The resident-agent policy: freeze normally, then park frozen forever.
    const row = await seed(db, executor, 'resident', {
      ...DEFAULT_LIFECYCLE_POLICY,
      stopAfterSeconds: null,
      archiveAfterSeconds: null,
    });
    await scanOnce(db, executor, locks, after(row, row.freezeAfterSeconds));
    expect(findByExternalId(db, 'resident')?.state).toBe('frozen');

    const yearLater = await scanOnce(
      db,
      executor,
      locks,
      after(row, 365 * 24 * 60 * 60),
    );
    expect(yearLater).toEqual({
      frozen: 0,
      stopped: 0,
      archived: 0,
      expiredKilled: 0,
      failures: [],
    });
    expect(findByExternalId(db, 'resident')?.state).toBe('frozen');
  });

  it('keeps sweeping past a sandbox whose container has vanished', async () => {
    const { db, executor, locks } = setup();
    const dead = await seed(db, executor, 'dead');
    const alive = await seed(db, executor, 'alive');
    // Container and disk gone behind the ledger's back. The row still says
    // active; the freeze attempt fails honestly.
    await executor.destroy(dead.sandboxId);

    const result = await scanOnce(
      db,
      executor,
      locks,
      after(alive, alive.freezeAfterSeconds),
    );
    // The dead row is reported, the row behind it still cools down.
    expect(result.failures).toEqual([
      {
        sandboxId: dead.sandboxId,
        message: expect.stringContaining('absent'),
      },
    ]);
    expect(result.frozen).toBe(1);
    expect(findByExternalId(db, 'alive')?.state).toBe('frozen');
    expect(executor.stateOf(alive.sandboxId)).toBe('paused');
    // The dead row was not written: reality never moved. Repairing it is
    // reconciliation's job, not the scanner's.
    expect(findByExternalId(db, 'dead')?.state).toBe('active');
  });
});

describe('idle scanner vs the per-key queue', () => {
  it('skips a sandbox whose key is busy instead of acting on a stale view', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');

    // Something long holds alice's slot — an acquire mid-create, a release
    // mid-destroy. Whatever it is knows more about this sandbox than the
    // sweep's snapshot does.
    let release!: () => void;
    const holder = locks.run(
      'alice',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const result = await scanOnce(
      db,
      executor,
      locks,
      after(row, row.freezeAfterSeconds),
    );
    expect(result).toEqual({
      frozen: 0,
      stopped: 0,
      archived: 0,
      expiredKilled: 0,
      failures: [],
    });
    expect(findByExternalId(db, 'alice')?.state).toBe('active');

    release();
    await holder;
    // Next sweep, with the key free, the freeze lands.
    const next = await scanOnce(
      db,
      executor,
      locks,
      after(row, row.freezeAfterSeconds),
    );
    expect(next).toEqual({
      frozen: 1,
      stopped: 0,
      archived: 0,
      expiredKilled: 0,
      failures: [],
    });
  });

  it('re-reads under the lock: a sandbox released mid-sweep is skipped, not failed', async () => {
    /** A slow freeze keeps the sweep busy while the release slips in. */
    class SlowFreezeExecutor extends FakeExecutor {
      async freeze(sandboxId: string): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await super.freeze(sandboxId);
      }
    }
    const db = openDb(':memory:');
    migrateDb(db, MIGRATIONS);
    const executor = new SlowFreezeExecutor();
    const locks = new KeyedQueue();
    const first = await seed(db, executor, 'first');
    const doomed = await seed(db, executor, 'doomed');

    // Both are due. While the sweep is stuck in first's slow freeze, the
    // user releases doomed. Without the re-read the sweep would act on its
    // snapshot and fail against a sandbox that no longer exists.
    const sweep = scanOnce(
      db,
      executor,
      locks,
      after(first, first.freezeAfterSeconds),
    );
    const released = locks.run('doomed', () =>
      destroySandbox(db, executor, doomed.sandboxId, null),
    );
    const [result] = await Promise.all([sweep, released]);

    expect(result).toEqual({
      frozen: 1,
      stopped: 0,
      archived: 0,
      expiredKilled: 0,
      failures: [],
    });
    expect(findByExternalId(db, 'doomed')).toBeUndefined();
  });
});

describe('idle scanner: the archive rung', () => {
  /** A short three-rung policy: freeze at 60, stop at 120, archive at 180. */
  const ARCHIVING_POLICY: LifecyclePolicy = {
    freezeAfterSeconds: 60,
    stopAfterSeconds: 120,
    archiveAfterSeconds: 180,
  };

  async function walkToStopped(
    db: Db,
    executor: FakeExecutor,
    locks: KeyedQueue,
    row: SandboxRow,
  ): Promise<void> {
    await scanOnce(db, executor, locks, after(row, 60));
    await scanOnce(db, executor, locks, after(row, 120));
    expect(findByExternalId(db, row.externalId)?.state).toBe('stopped');
  }

  it('archives a stopped sandbox idle past archiveAfterSeconds', async () => {
    const { db, executor, locks, store, archiver } = setupWithArchiver();
    const row = await seed(db, executor, 'alice', ARCHIVING_POLICY);
    await executor.writeFiles(row.sandboxId, [
      { path: 'kept.txt', content: Buffer.from('made it') },
    ]);
    await walkToStopped(db, executor, locks, row);

    const result = await scanOnce(
      db,
      executor,
      locks,
      after(row, 180),
      archiver,
    );
    expect(result).toEqual({
      frozen: 0,
      stopped: 0,
      archived: 1,
      expiredKilled: 0,
      failures: [],
    });
    expect(findByExternalId(db, 'alice')?.state).toBe('archived');
    expect(store.has(objectKey(row.sandboxId))).toBe(true);
    // Local copy freed: container and disk both gone.
    expect(executor.stateOf(row.sandboxId)).toBeUndefined();
    expect(await executor.listDisks()).not.toContain(row.sandboxId);
  });

  it('never moves the archive rung without an archiver', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice', ARCHIVING_POLICY);
    await walkToStopped(db, executor, locks, row);

    // No archiver passed: the row keeps its recorded intent, untouched.
    const result = await scanOnce(db, executor, locks, after(row, 9999));
    expect(result.archived).toBe(0);
    expect(findByExternalId(db, 'alice')?.state).toBe('stopped');
    expect(await executor.listDisks()).toContain(row.sandboxId);
  });

  it('never archives a policy that says archive: null', async () => {
    const { db, executor, locks, archiver } = setupWithArchiver();
    const row = await seed(db, executor, 'alice', {
      ...ARCHIVING_POLICY,
      archiveAfterSeconds: null,
    });
    await walkToStopped(db, executor, locks, row);

    const yearLater = await scanOnce(
      db,
      executor,
      locks,
      after(row, 365 * 24 * 60 * 60),
      archiver,
    );
    expect(yearLater.archived).toBe(0);
    expect(findByExternalId(db, 'alice')?.state).toBe('stopped');
  });

  it('an archive failure lands in failures without blocking the sweep', async () => {
    // The two-phase shape under test: the failing archive runs after —
    // and therefore cannot stall — the same sweep's cheap freeze.
    const { db, executor, locks, archiver } = setupWithArchiver();
    const doomed = await seed(db, executor, 'doomed', ARCHIVING_POLICY);
    await walkToStopped(db, executor, locks, doomed);
    const cooling = await seed(db, executor, 'cooling', ARCHIVING_POLICY);
    // Sabotage the upload: the store refuses everything.
    archiver.store.put = async () => {
      throw new Error('the bucket said no');
    };

    // One instant serves both rows (seeded milliseconds apart): cooling is
    // 180s idle (past freeze), doomed is 180s idle (past archive).
    const result = await scanOnce(
      db,
      executor,
      locks,
      after(cooling, 180),
      archiver,
    );
    expect(result.frozen).toBe(1);
    expect(result.archived).toBe(0);
    expect(result.failures).toEqual([
      {
        sandboxId: doomed.sandboxId,
        message: expect.stringContaining('the bucket said no'),
      },
    ]);
    // Retryable: still stopped, disk still local.
    expect(findByExternalId(db, 'doomed')?.state).toBe('stopped');
    expect(await executor.listDisks()).toContain(doomed.sandboxId);
  });

  it('kill-deadline on an archived row deletes the S3 object too', async () => {
    const { db, executor, locks, store, archiver } = setupWithArchiver();
    const row = await seed(db, executor, 'alice', ARCHIVING_POLICY);
    await walkToStopped(db, executor, locks, row);
    await scanOnce(db, executor, locks, after(row, 180), archiver);
    expect(store.has(objectKey(row.sandboxId))).toBe(true);
    setDeadline(db, row.sandboxId, {
      deadlineAt: after(row, 200).toISOString(),
      onDeadline: 'kill',
    });

    const result = await scanOnce(
      db,
      executor,
      locks,
      after(row, 200),
      archiver,
    );
    expect(result.expiredKilled).toBe(1);
    expect(findByExternalId(db, 'alice')).toBeUndefined();
    expect(store.has(objectKey(row.sandboxId))).toBe(false);
  });

  it('kill-deadline on a restoring row is deferred one sweep', async () => {
    const { db, executor, locks, archiver } = setupWithArchiver();
    const row = await seed(db, executor, 'alice', ARCHIVING_POLICY);
    await walkToStopped(db, executor, locks, row);
    await scanOnce(db, executor, locks, after(row, 180), archiver);
    // Begin a restore whose download hangs on a test-held promise, so the
    // row is mid-restoring when the killing sweep arrives.
    let releaseDownload!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const innerGet = archiver.store.get.bind(archiver.store);
    archiver.store.get = async (key, dest, onProgress) => {
      await gate;
      return innerGet(key, dest, onProgress);
    };
    const archived = findByExternalId(db, 'alice');
    if (!archived) throw new Error('row vanished');
    archiver.beginRestore(archived);
    expect(findByExternalId(db, 'alice')?.state).toBe('restoring');
    setDeadline(db, row.sandboxId, {
      deadlineAt: after(row, 200).toISOString(),
      onDeadline: 'kill',
    });

    // Mid-restore: the kill is deferred, the row survives this sweep.
    const during = await scanOnce(
      db,
      executor,
      locks,
      after(row, 300),
      archiver,
    );
    expect(during.expiredKilled).toBe(0);
    expect(findByExternalId(db, 'alice')?.state).toBe('restoring');

    releaseDownload();
    await archiver.restoreJoin(row.sandboxId);
    expect(findByExternalId(db, 'alice')?.state).toBe('active');

    // Next sweep, with the restore settled, the kill lands clean.
    const settled = await scanOnce(
      db,
      executor,
      locks,
      after(row, 300),
      archiver,
    );
    expect(settled.expiredKilled).toBe(1);
    expect(findByExternalId(db, 'alice')).toBeUndefined();
  });
});

describe('E2B deadline rule', () => {
  async function seedWithDeadline(
    db: Db,
    executor: FakeExecutor,
    externalId: string,
    row: SandboxRow | null,
    afterSeconds: number,
    onDeadline: 'kill' | 'pause',
  ): Promise<SandboxRow> {
    const seeded = row ?? (await seed(db, executor, externalId));
    setDeadline(db, seeded.sandboxId, {
      deadlineAt: after(seeded, afterSeconds).toISOString(),
      onDeadline,
    });
    return seeded;
  }

  it('kills an expired kill-deadline sandbox: container, disk and row gone', async () => {
    const { db, executor, locks } = setup();
    const row = await seedWithDeadline(
      db,
      executor,
      'doomed',
      null,
      100,
      'kill',
    );

    // Before the deadline nothing happens (idle is far below freeze too).
    const early = await scanOnce(db, executor, locks, after(row, 50));
    expect(early).toEqual({
      frozen: 0,
      stopped: 0,
      archived: 0,
      expiredKilled: 0,
      failures: [],
    });

    const late = await scanOnce(db, executor, locks, after(row, 100));
    expect(late).toEqual({
      frozen: 0,
      stopped: 0,
      archived: 0,
      expiredKilled: 1,
      failures: [],
    });
    expect(findByExternalId(db, 'doomed')).toBeUndefined();
    expect(executor.stateOf(row.sandboxId)).toBeUndefined();
    expect(await executor.listDisks()).not.toContain(row.sandboxId);
  });

  it('the deadline outranks idle cooling: due for both means dead, not frozen', async () => {
    const { db, executor, locks } = setup();
    const row = await seedWithDeadline(db, executor, 'both', null, 10, 'kill');
    // Way past freezeAfterSeconds AND past the deadline.
    const result = await scanOnce(
      db,
      executor,
      locks,
      after(row, row.freezeAfterSeconds + 1000),
    );
    expect(result).toEqual({
      frozen: 0,
      stopped: 0,
      archived: 0,
      expiredKilled: 1,
      failures: [],
    });
    expect(findByExternalId(db, 'both')).toBeUndefined();
  });

  it('activity does not extend a deadline — it is an absolute clock', async () => {
    const { db, executor, locks } = setup();
    const row = await seedWithDeadline(db, executor, 'busy', null, 100, 'kill');
    // The sandbox stays busy right up to the deadline; E2B kills anyway —
    // only create/connect/setTimeout move a deadline, never activity.
    touch(db, row.sandboxId, after(row, 99).toISOString());
    const result = await scanOnce(db, executor, locks, after(row, 101));
    expect(result.expiredKilled).toBe(1);
    expect(findByExternalId(db, 'busy')).toBeUndefined();
  });

  it('parks an expired pause-deadline sandbox frozen, once, and keeps the row', async () => {
    const { db, executor, locks } = setup();
    const row = await seedWithDeadline(
      db,
      executor,
      'parked',
      null,
      100,
      'pause',
    );

    const late = await scanOnce(db, executor, locks, after(row, 100));
    expect(late).toEqual({
      frozen: 1,
      stopped: 0,
      archived: 0,
      expiredKilled: 0,
      failures: [],
    });
    expect(findByExternalId(db, 'parked')?.state).toBe('frozen');
    expect(executor.stateOf(row.sandboxId)).toBe('paused');

    // A second sweep finds no physical work left: frozen already satisfies
    // the pause action, and the logical view reads the deadline directly.
    const again = await scanOnce(db, executor, locks, after(row, 200));
    expect(again).toEqual({
      frozen: 0,
      stopped: 0,
      archived: 0,
      expiredKilled: 0,
      failures: [],
    });
    expect(findByExternalId(db, 'parked')?.state).toBe('frozen');
  });
});
