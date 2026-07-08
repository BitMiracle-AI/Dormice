import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIFECYCLE_POLICY,
  type LifecyclePolicy,
} from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { type Db, migrateDb, openDb } from './db/db';
import { createSandbox, findByUserKey } from './db/ledger';
import type { SandboxRow } from './db/schema';
import { FakeExecutor } from './executor/fake';
import { KeyedQueue } from './keyed-queue';
import { releaseSandbox } from './lifecycle';
import { scanOnce } from './scanner';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

function setup() {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  return { db, executor: new FakeExecutor(), locks: new KeyedQueue() };
}

async function seed(
  db: Db,
  executor: FakeExecutor,
  userKey: string,
  policy: LifecyclePolicy = DEFAULT_LIFECYCLE_POLICY,
): Promise<SandboxRow> {
  const sandboxId = randomUUID();
  await executor.create(sandboxId);
  return createSandbox(db, { sandboxId, userKey, nodeId: 'node-test', policy });
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
    expect(result).toEqual({ frozen: 0, stopped: 0, failures: [] });
    expect(findByUserKey(db, 'alice')?.state).toBe('active');
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
    expect(result).toEqual({ frozen: 1, stopped: 0, failures: [] });
    expect(findByUserKey(db, 'alice')?.state).toBe('frozen');
    expect(executor.stateOf(row.sandboxId)).toBe('paused');
  });

  it('stops a frozen sandbox idle past stopAfterSeconds', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    await scanOnce(db, executor, locks, after(row, row.freezeAfterSeconds));
    const result = await scanOnce(
      db,
      executor,
      locks,
      after(row, row.stopAfterSeconds),
    );
    expect(result).toEqual({ frozen: 0, stopped: 1, failures: [] });
    expect(findByUserKey(db, 'alice')?.state).toBe('stopped');
    expect(executor.stateOf(row.sandboxId)).toBe('stopped');
  });

  it('moves one rung per sweep, even for a long-dead sandbox', async () => {
    const { db, executor, locks } = setup();
    const row = await seed(db, executor, 'alice');
    const yearLater = after(row, 365 * 24 * 60 * 60);
    expect(await scanOnce(db, executor, locks, yearLater)).toEqual({
      frozen: 1,
      stopped: 0,
      failures: [],
    });
    expect(findByUserKey(db, 'alice')?.state).toBe('frozen');
    expect(await scanOnce(db, executor, locks, yearLater)).toEqual({
      frozen: 0,
      stopped: 1,
      failures: [],
    });
    expect(findByUserKey(db, 'alice')?.state).toBe('stopped');
  });

  it('applies each sandbox its own policy', async () => {
    const { db, executor, locks } = setup();
    const quick = await seed(db, executor, 'quick', {
      ...DEFAULT_LIFECYCLE_POLICY,
      freezeAfterSeconds: 60,
    });
    const slow = await seed(db, executor, 'slow');
    const result = await scanOnce(db, executor, locks, after(quick, 100));
    expect(result).toEqual({ frozen: 1, stopped: 0, failures: [] });
    expect(findByUserKey(db, 'quick')?.state).toBe('frozen');
    expect(findByUserKey(db, 'slow')?.state).toBe('active');
    expect(executor.stateOf(slow.sandboxId)).toBe('running');
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
    expect(findByUserKey(db, 'alive')?.state).toBe('frozen');
    expect(executor.stateOf(alive.sandboxId)).toBe('paused');
    // The dead row was not written: reality never moved. Repairing it is
    // reconciliation's job, not the scanner's.
    expect(findByUserKey(db, 'dead')?.state).toBe('active');
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
    expect(result).toEqual({ frozen: 0, stopped: 0, failures: [] });
    expect(findByUserKey(db, 'alice')?.state).toBe('active');

    release();
    await holder;
    // Next sweep, with the key free, the freeze lands.
    const next = await scanOnce(
      db,
      executor,
      locks,
      after(row, row.freezeAfterSeconds),
    );
    expect(next).toEqual({ frozen: 1, stopped: 0, failures: [] });
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
      releaseSandbox(db, executor, doomed.sandboxId),
    );
    const [result] = await Promise.all([sweep, released]);

    expect(result).toEqual({ frozen: 1, stopped: 0, failures: [] });
    expect(findByUserKey(db, 'doomed')).toBeUndefined();
  });
});
