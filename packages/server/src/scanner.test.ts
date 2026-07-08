import { randomUUID } from 'node:crypto';
import {
  DEFAULT_LIFECYCLE_POLICY,
  type LifecyclePolicy,
} from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { type Db, migrateDb, openDb } from './db/db';
import { createSandbox, findByUserKey } from './db/ledger';
import type { SandboxRow } from './db/schema';
import { FakeExecutor } from './executor/fake';
import { scanOnce } from './scanner';

const MIGRATIONS = new URL('../drizzle', import.meta.url).pathname;

function setup() {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  return { db, executor: new FakeExecutor() };
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
    const { db, executor } = setup();
    const row = await seed(db, executor, 'alice');
    const result = await scanOnce(db, executor, after(row, 1));
    expect(result).toEqual({ frozen: 0, stopped: 0 });
    expect(findByUserKey(db, 'alice')?.state).toBe('active');
    expect(executor.stateOf(row.sandboxId)).toBe('running');
  });

  it('freezes a sandbox idle past freezeAfterSeconds', async () => {
    const { db, executor } = setup();
    const row = await seed(db, executor, 'alice');
    const result = await scanOnce(
      db,
      executor,
      after(row, row.freezeAfterSeconds),
    );
    expect(result).toEqual({ frozen: 1, stopped: 0 });
    expect(findByUserKey(db, 'alice')?.state).toBe('frozen');
    expect(executor.stateOf(row.sandboxId)).toBe('paused');
  });

  it('stops a frozen sandbox idle past stopAfterSeconds', async () => {
    const { db, executor } = setup();
    const row = await seed(db, executor, 'alice');
    await scanOnce(db, executor, after(row, row.freezeAfterSeconds));
    const result = await scanOnce(
      db,
      executor,
      after(row, row.stopAfterSeconds),
    );
    expect(result).toEqual({ frozen: 0, stopped: 1 });
    expect(findByUserKey(db, 'alice')?.state).toBe('stopped');
    expect(executor.stateOf(row.sandboxId)).toBe('stopped');
  });

  it('moves one rung per sweep, even for a long-dead sandbox', async () => {
    const { db, executor } = setup();
    const row = await seed(db, executor, 'alice');
    const yearLater = after(row, 365 * 24 * 60 * 60);
    expect(await scanOnce(db, executor, yearLater)).toEqual({
      frozen: 1,
      stopped: 0,
    });
    expect(findByUserKey(db, 'alice')?.state).toBe('frozen');
    expect(await scanOnce(db, executor, yearLater)).toEqual({
      frozen: 0,
      stopped: 1,
    });
    expect(findByUserKey(db, 'alice')?.state).toBe('stopped');
  });

  it('applies each sandbox its own policy', async () => {
    const { db, executor } = setup();
    const quick = await seed(db, executor, 'quick', {
      ...DEFAULT_LIFECYCLE_POLICY,
      freezeAfterSeconds: 60,
    });
    const slow = await seed(db, executor, 'slow');
    const result = await scanOnce(db, executor, after(quick, 100));
    expect(result).toEqual({ frozen: 1, stopped: 0 });
    expect(findByUserKey(db, 'quick')?.state).toBe('frozen');
    expect(findByUserKey(db, 'slow')?.state).toBe('active');
    expect(executor.stateOf(slow.sandboxId)).toBe('running');
  });
});
