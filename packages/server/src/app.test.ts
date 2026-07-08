import { fileURLToPath } from 'node:url';
import { DEFAULT_LIFECYCLE_POLICY } from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { migrateDb, openDb } from './db/db';
import { FakeExecutor } from './executor/fake';
import { KeyedQueue } from './keyed-queue';
import { reconcile } from './reconciler';
import { scanOnce } from './scanner';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const TOKEN = 'test-token-test-token-test-token';

function testApp(executor: FakeExecutor = new FakeExecutor()) {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  // Through loadConfig on purpose: defaults are adjudicated once, in the
  // schema — a hand-written literal here would drift as knobs are added.
  const config = loadConfig({
    DORMICE_DB_PATH: ':memory:',
    DORMICE_NODE_ID: 'node-test',
    DORMICE_API_TOKEN: TOKEN,
  });
  const locks = new KeyedQueue();
  const app = buildApp({ config, db, executor, locks, logger: false });
  return { app, db, executor, locks };
}

const authed = { authorization: `Bearer ${TOKEN}` };

function acquire(
  app: ReturnType<typeof testApp>['app'],
  payload: Record<string, unknown>,
  headers: Record<string, string> = authed,
) {
  return app.inject({
    method: 'POST',
    url: '/acquireSandbox',
    headers,
    payload,
  });
}

function rpc(
  app: ReturnType<typeof testApp>['app'],
  url: string,
  payload: Record<string, unknown> = {},
) {
  return app.inject({ method: 'POST', url, headers: authed, payload });
}

/** Time travel for the scanner: the instant `seconds` after an ISO timestamp. */
function after(iso: string, seconds: number): Date {
  return new Date(Date.parse(iso) + seconds * 1000);
}

describe('auth', () => {
  it('leaves /healthz open', async () => {
    const res = await testApp().app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects API calls without a token', async () => {
    const res = await acquire(testApp().app, { userKey: 'u' }, {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects API calls with a wrong token', async () => {
    const res = await acquire(
      testApp().app,
      { userKey: 'u' },
      { authorization: 'Bearer wrong-token-wrong-token-wrong-token' },
    );
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /acquireSandbox', () => {
  it('creates a sandbox on first acquire, with default policy', async () => {
    const { app, executor } = testApp();
    const res = await acquire(app, { userKey: 'alice' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.sandbox.state).toBe('active');
    expect(body.sandbox.userKey).toBe('alice');
    expect(body.sandbox.policy).toEqual(DEFAULT_LIFECYCLE_POLICY);
    expect(body.sandbox.endpoint).toBe('http://127.0.0.1:3676');
    // The ledger and reality agree: the container is actually running.
    expect(executor.stateOf(body.sandbox.sandboxId)).toBe('running');
  });

  it('is idempotent: same user key returns the same sandbox', async () => {
    const { app } = testApp();
    const first = (await acquire(app, { userKey: 'alice' })).json();
    const second = (await acquire(app, { userKey: 'alice' })).json();
    expect(second.sandbox.sandboxId).toBe(first.sandbox.sandboxId);
  });

  it('gives different user keys different sandboxes', async () => {
    const { app } = testApp();
    const alice = (await acquire(app, { userKey: 'alice' })).json();
    const bob = (await acquire(app, { userKey: 'bob' })).json();
    expect(bob.sandbox.sandboxId).not.toBe(alice.sandbox.sandboxId);
  });

  it('stores a policy override, including explicit null for archive', async () => {
    const res = await acquire(testApp().app, {
      userKey: 'alice',
      policy: { freezeAfterSeconds: 60, archiveAfterSeconds: null },
    });
    expect(res.json().sandbox.policy).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      freezeAfterSeconds: 60,
      archiveAfterSeconds: null,
    });
  });

  it('rejects an override whose merged result breaks the ordering rule', async () => {
    const res = await acquire(testApp().app, {
      userKey: 'alice',
      policy: { archiveAfterSeconds: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/stopAfterSeconds/);
  });

  it('rejects a malformed body', async () => {
    const res = await acquire(testApp().app, { policy: {} });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid override even when the sandbox already exists', async () => {
    const { app } = testApp();
    await acquire(app, { userKey: 'alice' });
    // The override would not apply (the sandbox exists), but it is still
    // the caller's mistake — a 400, never a silent ignore.
    const res = await acquire(app, {
      userKey: 'alice',
      policy: { archiveAfterSeconds: 1 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('concurrent acquires', () => {
  /** create() takes seconds under real Docker; 20ms makes two in-flight
   *  requests overlap deterministically. */
  class SlowCreateExecutor extends FakeExecutor {
    async create(sandboxId: string): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await super.create(sandboxId);
    }
  }

  it('same key in parallel shares one sandbox, builds one container', async () => {
    const executor = new SlowCreateExecutor();
    const { app } = testApp(executor);
    const [first, second] = await Promise.all([
      acquire(app, { userKey: 'alice' }),
      acquire(app, { userKey: 'alice' }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().sandbox.sandboxId).toBe(
      first.json().sandbox.sandboxId,
    );
    // Exactly one container: the second request queued behind the first's
    // slot and found its row instead of racing it and leaking an orphan.
    expect((await executor.listContainers()).size).toBe(1);
  });

  it('different keys in parallel still get different sandboxes', async () => {
    const executor = new SlowCreateExecutor();
    const { app } = testApp(executor);
    const [alice, bob] = await Promise.all([
      acquire(app, { userKey: 'alice' }),
      acquire(app, { userKey: 'bob' }),
    ]);
    expect(bob.json().sandbox.sandboxId).not.toBe(
      alice.json().sandbox.sandboxId,
    );
    expect((await executor.listContainers()).size).toBe(2);
  });
});

describe('acquire wakes cold sandboxes', () => {
  it('unfreezes a frozen sandbox back to active', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { userKey: 'alice' })).json();
    const id = created.sandbox.sandboxId;

    await scanOnce(
      db,
      executor,
      locks,
      after(
        created.sandbox.lastActiveAt,
        DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
      ),
    );
    expect(executor.stateOf(id)).toBe('paused');

    const woken = (await acquire(app, { userKey: 'alice' })).json();
    expect(woken.sandbox.sandboxId).toBe(id);
    expect(woken.sandbox.state).toBe('active');
    expect(executor.stateOf(id)).toBe('running');
  });

  it('starts a stopped sandbox back to active', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { userKey: 'alice' })).json();
    const id = created.sandbox.sandboxId;

    const lastActiveAt = created.sandbox.lastActiveAt;
    await scanOnce(
      db,
      executor,
      locks,
      after(lastActiveAt, DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds),
    );
    await scanOnce(
      db,
      executor,
      locks,
      after(lastActiveAt, DEFAULT_LIFECYCLE_POLICY.stopAfterSeconds),
    );
    expect(executor.stateOf(id)).toBe('stopped');

    const woken = (await acquire(app, { userKey: 'alice' })).json();
    expect(woken.sandbox.sandboxId).toBe(id);
    expect(woken.sandbox.state).toBe('active');
    expect(executor.stateOf(id)).toBe('running');
  });

  it('waking refreshes the idle clock', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { userKey: 'alice' })).json();

    await scanOnce(
      db,
      executor,
      locks,
      after(
        created.sandbox.lastActiveAt,
        DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
      ),
    );
    // touch() stamps real wall-clock time, so give it a distinct millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const woken = (await acquire(app, { userKey: 'alice' })).json();
    expect(Date.parse(woken.sandbox.lastActiveAt)).toBeGreaterThan(
      Date.parse(created.sandbox.lastActiveAt),
    );
  });
});

describe('scanner vs acquire on the same key', () => {
  /** memory.reclaim can hold a real freeze open for tens of seconds. */
  class SlowFreezeExecutor extends FakeExecutor {
    async freeze(sandboxId: string): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await super.freeze(sandboxId);
    }
  }

  it('an acquire during a freeze waits its turn and gets a running sandbox', async () => {
    const executor = new SlowFreezeExecutor();
    const { app, db, locks } = testApp(executor);
    const created = (await acquire(app, { userKey: 'alice' })).json();
    const id = created.sandbox.sandboxId;

    // The scanner decides to freeze; the acquire lands mid-freeze.
    // Unserialized, the acquire read `active` from the ledger, answered
    // "ready", and the caller ended up holding a paused sandbox that the
    // reconciler would never repair (ledger and reality agreed on frozen).
    const sweep = scanOnce(
      db,
      executor,
      locks,
      after(
        created.sandbox.lastActiveAt,
        DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
      ),
    );
    const woken = acquire(app, { userKey: 'alice' });
    const [sweepResult, res] = await Promise.all([sweep, woken]);

    expect(sweepResult.frozen).toBe(1);
    expect(res.json().sandbox.state).toBe('active');
    // The answer told the truth: the container really is running.
    expect(executor.stateOf(id)).toBe('running');
  });
});

describe('concurrent releases of the same key', () => {
  /** destroy() takes seconds under real Docker (unpause, kill, wait, rm). */
  class SlowDestroyExecutor extends FakeExecutor {
    async destroy(sandboxId: string): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await super.destroy(sandboxId);
    }
  }

  it('one reports released, the other reports the goal state — no 500', async () => {
    const executor = new SlowDestroyExecutor();
    const { app } = testApp(executor);
    await acquire(app, { userKey: 'alice' });

    const [a, b] = await Promise.all([
      rpc(app, '/releaseSandbox', { userKey: 'alice' }),
      rpc(app, '/releaseSandbox', { userKey: 'alice' }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const released = [a.json().released, b.json().released];
    expect(released.filter(Boolean)).toHaveLength(1);
  });
});

describe('acquire after reality moved behind the ledger', () => {
  it('returns a fresh sandbox when container and disk are truly gone', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { userKey: 'alice' })).json();
    // Container and disk wiped behind the daemon's back — the end state of
    // a release that crashed after the executor's work, before the ledger's.
    await executor.destroy(created.sandbox.sandboxId);

    // The heartbeat reconciles before every scan; the dead row is deleted
    // within one interval, freeing the key.
    await reconcile(db, executor, locks, new Set());

    const again = (await acquire(app, { userKey: 'alice' })).json();
    expect(again.status).toBe('ready');
    expect(again.sandbox.sandboxId).not.toBe(created.sandbox.sandboxId);
    // This time the sandbox is real.
    expect(executor.stateOf(again.sandbox.sandboxId)).toBe('running');
  });

  it('returns the same sandbox after its exited container was pruned', async () => {
    // A stopped sandbox is an exited container plus a disk, and a routine
    // `docker container prune` eats the container object. The disk — the
    // sandbox's actual data — survives, so the sandbox must survive too:
    // same key, same sandboxId, rebuilt from the disk. Never a silent
    // fresh empty box.
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { userKey: 'alice' })).json();
    const id = created.sandbox.sandboxId;
    const lastActiveAt = created.sandbox.lastActiveAt;
    await scanOnce(
      db,
      executor,
      locks,
      after(lastActiveAt, DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds),
    );
    await scanOnce(
      db,
      executor,
      locks,
      after(lastActiveAt, DEFAULT_LIFECYCLE_POLICY.stopAfterSeconds),
    );
    executor.vanishContainer(id);

    await reconcile(db, executor, locks, new Set());

    const again = (await acquire(app, { userKey: 'alice' })).json();
    expect(again.sandbox.sandboxId).toBe(id);
    expect(again.sandbox.state).toBe('active');
    expect(executor.stateOf(id)).toBe('running');
  });
});

describe('POST /listSandboxes', () => {
  it('requires a token', async () => {
    const res = await testApp().app.inject({
      method: 'POST',
      url: '/listSandboxes',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('reports every sandbox with its current lifecycle state', async () => {
    const { app, db, executor, locks } = testApp();
    // Give alice a shorter freeze threshold so one sweep freezes only her.
    const alice = (
      await acquire(app, {
        userKey: 'alice',
        policy: { freezeAfterSeconds: 60 },
      })
    ).json();
    await acquire(app, { userKey: 'bob' });
    await scanOnce(db, executor, locks, after(alice.sandbox.lastActiveAt, 60));

    const res = await rpc(app, '/listSandboxes');
    expect(res.statusCode).toBe(200);
    const states = Object.fromEntries(
      res
        .json()
        .sandboxes.map((s: { userKey: string; state: string }) => [
          s.userKey,
          s.state,
        ]),
    );
    expect(states).toEqual({ alice: 'frozen', bob: 'active' });
  });
});

describe('POST /releaseSandbox', () => {
  it('destroys the container and forgets the key', async () => {
    const { app, executor } = testApp();
    const created = (await acquire(app, { userKey: 'alice' })).json();
    const id = created.sandbox.sandboxId;

    const res = await rpc(app, '/releaseSandbox', { userKey: 'alice' });
    expect(res.json()).toEqual({ released: true });
    // Reality and ledger agree: container gone, key free again — the next
    // acquire builds a brand-new sandbox.
    expect(executor.stateOf(id)).toBeUndefined();
    const again = (await acquire(app, { userKey: 'alice' })).json();
    expect(again.sandbox.sandboxId).not.toBe(id);
  });

  it('releases a cold sandbox too', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { userKey: 'alice' })).json();
    await scanOnce(
      db,
      executor,
      locks,
      after(
        created.sandbox.lastActiveAt,
        DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
      ),
    );
    expect(executor.stateOf(created.sandbox.sandboxId)).toBe('paused');

    const res = await rpc(app, '/releaseSandbox', { userKey: 'alice' });
    expect(res.json()).toEqual({ released: true });
    expect(executor.stateOf(created.sandbox.sandboxId)).toBeUndefined();
  });

  it('is idempotent: a key with no sandbox reports released false', async () => {
    const res = await rpc(testApp().app, '/releaseSandbox', {
      userKey: 'nobody',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ released: false });
  });
});
