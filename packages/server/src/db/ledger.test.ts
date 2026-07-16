import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIFECYCLE_POLICY } from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { type Db, migrateDb, openDb } from './db';
import { createSandbox, findByName, touch, transition } from './ledger';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

function testDb(): Db {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  return db;
}

function create(db: Db, name = 'user-1') {
  return createSandbox(db, {
    id: randomUUID(),
    name,
    nodeId: 'node-1',
    policy: DEFAULT_LIFECYCLE_POLICY,
  });
}

describe('ledger', () => {
  it('creates a sandbox in active state and finds it by external id', () => {
    const db = testDb();
    const created = create(db);
    expect(created.state).toBe('active');
    expect(findByName(db, 'user-1')).toEqual(created);
    expect(findByName(db, 'someone-else')).toBeUndefined();
  });

  it('enforces one sandbox per external id at the database level', () => {
    const db = testDb();
    create(db);
    expect(() => create(db)).toThrow(/UNIQUE/);
  });

  it('walks the full lifecycle: active -> frozen -> stopped -> archived -> restoring -> active', () => {
    const db = testDb();
    const { id: sandboxId } = create(db);
    for (const to of [
      'frozen',
      'stopped',
      'archived',
      'restoring',
      'active',
    ] as const) {
      expect(transition(db, sandboxId, to).state).toBe(to);
    }
    expect(findByName(db, 'user-1')?.state).toBe('active');
  });

  it('wakes a frozen sandbox straight back to active', () => {
    const db = testDb();
    const { id: sandboxId } = create(db);
    transition(db, sandboxId, 'frozen');
    expect(transition(db, sandboxId, 'active').state).toBe('active');
  });

  it('rejects skipping rungs on the way down, except rebuild', () => {
    const db = testDb();
    const { id: sandboxId } = create(db);
    expect(() => transition(db, sandboxId, 'archived')).toThrow(
      /illegal transition/,
    );
    // The one legal two-rung move: rebuild removes a running container
    // outright, with no paused moment in between to record.
    expect(transition(db, sandboxId, 'stopped').state).toBe('stopped');
  });

  it('rejects waking an archived sandbox without going through restoring', () => {
    const db = testDb();
    const { id: sandboxId } = create(db);
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

  it('touch refreshes the idle clock to the injected instant', () => {
    const db = testDb();
    const { id: sandboxId, lastActiveAt } = create(db);
    const future = new Date(Date.parse(lastActiveAt) + 60_000).toISOString();
    expect(touch(db, sandboxId, future).lastActiveAt).toBe(future);
  });
});
