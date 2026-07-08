import { randomUUID } from 'node:crypto';
import { DEFAULT_LIFECYCLE_POLICY } from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { type Db, migrateDb, openDb } from './db';
import { createSandbox, findByUserKey, transition } from './ledger';

const MIGRATIONS = new URL('../../drizzle', import.meta.url).pathname;

function testDb(): Db {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  return db;
}

function create(db: Db, userKey = 'user-1') {
  return createSandbox(db, {
    sandboxId: randomUUID(),
    userKey,
    nodeId: 'node-1',
    policy: DEFAULT_LIFECYCLE_POLICY,
  });
}

describe('ledger', () => {
  it('creates a sandbox in active state and finds it by user key', () => {
    const db = testDb();
    const created = create(db);
    expect(created.state).toBe('active');
    expect(findByUserKey(db, 'user-1')).toEqual(created);
    expect(findByUserKey(db, 'someone-else')).toBeUndefined();
  });

  it('enforces one sandbox per user key at the database level', () => {
    const db = testDb();
    create(db);
    expect(() => create(db)).toThrow(/UNIQUE/);
  });

  it('walks the full lifecycle: active -> frozen -> stopped -> archived -> restoring -> active', () => {
    const db = testDb();
    const { sandboxId } = create(db);
    for (const to of [
      'frozen',
      'stopped',
      'archived',
      'restoring',
      'active',
    ] as const) {
      expect(transition(db, sandboxId, to).state).toBe(to);
    }
    expect(findByUserKey(db, 'user-1')?.state).toBe('active');
  });

  it('wakes a frozen sandbox straight back to active', () => {
    const db = testDb();
    const { sandboxId } = create(db);
    transition(db, sandboxId, 'frozen');
    expect(transition(db, sandboxId, 'active').state).toBe('active');
  });

  it('rejects skipping rungs on the way down', () => {
    const db = testDb();
    const { sandboxId } = create(db);
    expect(() => transition(db, sandboxId, 'stopped')).toThrow(
      /illegal transition/,
    );
    expect(() => transition(db, sandboxId, 'archived')).toThrow(
      /illegal transition/,
    );
  });

  it('rejects waking an archived sandbox without going through restoring', () => {
    const db = testDb();
    const { sandboxId } = create(db);
    transition(db, sandboxId, 'frozen');
    transition(db, sandboxId, 'stopped');
    transition(db, sandboxId, 'archived');
    expect(() => transition(db, sandboxId, 'active')).toThrow(
      /illegal transition/,
    );
  });

  it('rejects transitions on unknown sandboxes', () => {
    const db = testDb();
    expect(() => transition(db, 'no-such-id', 'frozen')).toThrow(/not found/);
  });
});
