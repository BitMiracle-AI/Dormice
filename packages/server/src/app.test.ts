import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIFECYCLE_POLICY,
  FILE_SIZE_LIMIT_BYTES,
  hostMetricsResponseSchema,
} from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { Archiver } from './archive/archiver';
import { MemStore } from './archive/mem-store';
import { objectKey } from './archive/store';
import { loadConfig } from './config';
import { migrateDb, openDb } from './db/db';
import { findById, transition } from './db/ledger';
import { FakeExecutor } from './executor/fake';
import { KeyedQueue } from './keyed-queue';
import { ARCHIVE_DEFAULT_SECONDS } from './policy';
import { reconcile } from './reconciler';
import { scanOnce } from './scanner';
import {
  configureNode,
  registerTestTemplate,
  TEST_S3,
  type TestConfig,
} from './testing';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const TOKEN = 'test-token-test-token-test-token';

function testApp(
  executor: FakeExecutor = new FakeExecutor(),
  configured: TestConfig = {},
  env: Record<string, string> = {},
) {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  // Through loadConfig on purpose: defaults are adjudicated once, in the
  // schema — a hand-written literal here would drift as knobs are added.
  const config = loadConfig({
    DORMICE_DB_PATH: ':memory:',
    DORMICE_NODE_ID: 'node-test',
    DORMICE_API_TOKEN: TOKEN,
    ...env,
  });
  // The configuration copy a check-in would have applied: the node reads
  // every knob from it, so a test that wants a domain or a store
  // configures the node the way the gateway would. `env` is for the
  // node's own identity (its data dir, its base image), nothing else.
  configureNode(db, configured);
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
    const res = await acquire(testApp().app, { name: 'u' }, {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects API calls with a wrong token', async () => {
    const res = await acquire(
      testApp().app,
      { name: 'u' },
      { authorization: 'Bearer wrong-token-wrong-token-wrong-token' },
    );
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /acquireSandbox', () => {
  it('creates a sandbox on first acquire, with default policy', async () => {
    const { app, executor } = testApp();
    const res = await acquire(app, { name: 'alice' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.sandbox.state).toBe('active');
    expect(body.sandbox.name).toBe('alice');
    expect(body.sandbox.policy).toEqual(DEFAULT_LIFECYCLE_POLICY);
    expect(body.sandbox.endpoint).toBe('http://127.0.0.1:3676');
    // The ledger and reality agree: the container is actually running.
    expect(executor.stateOf(body.sandbox.id)).toBe('running');
  });

  it('is idempotent: the same name returns the same sandbox', async () => {
    const { app } = testApp();
    const first = (await acquire(app, { name: 'alice' })).json();
    const second = (await acquire(app, { name: 'alice' })).json();
    expect(second.sandbox.id).toBe(first.sandbox.id);
    // `created` is how a caller sees which of the two happened — the flag
    // must not lie in either direction.
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  it('gives different names different sandboxes', async () => {
    const { app } = testApp();
    const alice = (await acquire(app, { name: 'alice' })).json();
    const bob = (await acquire(app, { name: 'bob' })).json();
    expect(bob.sandbox.id).not.toBe(alice.sandbox.id);
  });

  it('stores a policy override, including explicit null for archive', async () => {
    const res = await acquire(testApp().app, {
      name: 'alice',
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
      name: 'alice',
      policy: { freezeAfterSeconds: 61, stopAfterSeconds: 60 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/freezeAfterSeconds/);
  });

  it('refuses an archive-asking policy when no S3 is configured', async () => {
    // Without an archiver a stored archive threshold would be a standing
    // lie; the daemon refuses rather than nodding along.
    const res = await acquire(testApp().app, {
      name: 'alice',
      policy: { archiveAfterSeconds: 3600 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(
      /archiving requires an S3 archive store/,
    );
  });

  it('rejects a malformed body', async () => {
    const res = await acquire(testApp().app, { policy: {} });
    expect(res.statusCode).toBe(400);
  });

  it('stores stopAfterSeconds: null — the never-stop resident policy', async () => {
    const res = await acquire(testApp().app, {
      name: 'resident',
      policy: { stopAfterSeconds: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sandbox.policy.stopAfterSeconds).toBeNull();
  });

  it('rejects an invalid override even when the sandbox already exists', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice' });
    // The override would not apply (the sandbox exists), but it is still
    // the caller's mistake — a 400, never a silent ignore.
    const res = await acquire(app, {
      name: 'alice',
      policy: { archiveAfterSeconds: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('stores metadata at creation and echoes {} when none was given', async () => {
    const { app } = testApp();
    const labeled = await acquire(app, {
      name: 'alice',
      metadata: { app: 'crawler', env: 'prod' },
    });
    expect(labeled.json().sandbox.metadata).toEqual({
      app: 'crawler',
      env: 'prod',
    });
    const bare = await acquire(app, { name: 'bob' });
    expect(bare.json().sandbox.metadata).toEqual({});
  });

  it('keeps stored metadata on the idempotent path, but a malformed value is still a 400', async () => {
    const { app } = testApp();
    await acquire(app, {
      name: 'alice',
      metadata: { app: 'crawler' },
    });
    // Same rule as policy/template: creation-time only, never an update.
    const again = await acquire(app, {
      name: 'alice',
      metadata: { app: 'other' },
    });
    expect(again.json().sandbox.metadata).toEqual({ app: 'crawler' });
    // Non-string values are outside the label contract — the caller's
    // mistake even though it would not have applied.
    const bad = await acquire(app, {
      name: 'alice',
      metadata: { app: 42 },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('error shape', () => {
  it('answers validation failures with the protocol {message} body on every route', async () => {
    // destroySandbox declares no error schema; without the global error
    // handler Fastify's native multi-field shape leaked here.
    const res = await rpc(testApp().app, '/destroySandbox', {});
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json())).toEqual(['message']);
  });

  it('answers unknown routes with the same {message} shape', async () => {
    const res = await rpc(testApp().app, '/noSuchVerb');
    expect(res.statusCode).toBe(404);
    expect(Object.keys(res.json())).toEqual(['message']);
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
      acquire(app, { name: 'alice' }),
      acquire(app, { name: 'alice' }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().sandbox.id).toBe(first.json().sandbox.id);
    // Exactly one container: the second request queued behind the first's
    // slot and found its row instead of racing it and leaking an orphan.
    expect((await executor.listContainers()).size).toBe(1);
  });

  it('different keys in parallel still get different sandboxes', async () => {
    const executor = new SlowCreateExecutor();
    const { app } = testApp(executor);
    const [alice, bob] = await Promise.all([
      acquire(app, { name: 'alice' }),
      acquire(app, { name: 'bob' }),
    ]);
    expect(bob.json().sandbox.id).not.toBe(alice.json().sandbox.id);
    expect((await executor.listContainers()).size).toBe(2);
  });
});

describe('acquire wakes cold sandboxes', () => {
  it('unfreezes a frozen sandbox back to active', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();
    const id = created.sandbox.id;

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

    const woken = (await acquire(app, { name: 'alice' })).json();
    expect(woken.sandbox.id).toBe(id);
    expect(woken.sandbox.state).toBe('active');
    // A wake is not a creation, however cold the start.
    expect(woken.created).toBe(false);
    expect(executor.stateOf(id)).toBe('running');
  });

  it('starts a stopped sandbox back to active', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (
      await acquire(app, {
        name: 'alice',
        policy: { freezeAfterSeconds: 60, stopAfterSeconds: 120 },
      })
    ).json();
    const id = created.sandbox.id;

    const lastActiveAt = created.sandbox.lastActiveAt;
    await scanOnce(db, executor, locks, after(lastActiveAt, 60));
    await scanOnce(db, executor, locks, after(lastActiveAt, 120));
    expect(executor.stateOf(id)).toBe('stopped');

    const woken = (await acquire(app, { name: 'alice' })).json();
    expect(woken.sandbox.id).toBe(id);
    expect(woken.sandbox.state).toBe('active');
    expect(executor.stateOf(id)).toBe('running');
  });

  it('waking refreshes the idle clock', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();

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
    const woken = (await acquire(app, { name: 'alice' })).json();
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
    const created = (await acquire(app, { name: 'alice' })).json();
    const id = created.sandbox.id;

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
    const woken = acquire(app, { name: 'alice' });
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
    await acquire(app, { name: 'alice' });

    const [a, b] = await Promise.all([
      rpc(app, '/destroySandbox', { name: 'alice' }),
      rpc(app, '/destroySandbox', { name: 'alice' }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const released = [a.json().destroyed, b.json().destroyed];
    expect(released.filter(Boolean)).toHaveLength(1);
  });
});

describe('acquire after reality moved behind the ledger', () => {
  it('returns a fresh sandbox when container and disk are truly gone', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();
    // Container and disk wiped behind the daemon's back — the end state of
    // a release that crashed after the executor's work, before the ledger's.
    await executor.destroy(created.sandbox.id);

    // The heartbeat reconciles before every scan; the dead row is deleted
    // within one interval, freeing the key.
    await reconcile(db, executor, locks, new Set());

    const again = (await acquire(app, { name: 'alice' })).json();
    expect(again.status).toBe('ready');
    expect(again.sandbox.id).not.toBe(created.sandbox.id);
    // The old incarnation's row is gone, so this acquire genuinely creates.
    expect(again.created).toBe(true);
    // This time the sandbox is real.
    expect(executor.stateOf(again.sandbox.id)).toBe('running');
  });

  it('returns the same sandbox after its exited container was pruned', async () => {
    // A stopped sandbox is an exited container plus a disk, and a routine
    // `docker container prune` eats the container object. The disk — the
    // sandbox's actual data — survives, so the sandbox must survive too:
    // same name, same id, rebuilt from the disk. Never a silent fresh
    // empty box.
    const { app, db, executor, locks } = testApp();
    const created = (
      await acquire(app, {
        name: 'alice',
        policy: { freezeAfterSeconds: 60, stopAfterSeconds: 120 },
      })
    ).json();
    const id = created.sandbox.id;
    const lastActiveAt = created.sandbox.lastActiveAt;
    await scanOnce(db, executor, locks, after(lastActiveAt, 60));
    await scanOnce(db, executor, locks, after(lastActiveAt, 120));
    executor.vanishContainer(id);

    await reconcile(db, executor, locks, new Set());

    const again = (await acquire(app, { name: 'alice' })).json();
    expect(again.sandbox.id).toBe(id);
    expect(again.sandbox.state).toBe('active');
    // The survival must not be misreported as a creation — a caller who
    // trusts `created` would wrongly assume an empty /home/user.
    expect(again.created).toBe(false);
    expect(executor.stateOf(id)).toBe('running');
  });
});

describe('acquire finds the shell dead under an active row', () => {
  // The blind spot: a gVisor box dies whole (OOM, pids cap) and the ledger
  // keeps saying active until the heartbeat's next reconcile — up to a
  // scan interval later. Inside that window the old acquire answered
  // "ready" from the ledger alone, and the caller's very next call failed
  // "container is stopped, expected running". Measured by a consumer: 60
  // such failures in two days, all within 120s of a death.
  it('records the death, cold-starts the shell, and answers a true ready with lastExit set', async () => {
    const { app, executor } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();
    const id = created.sandbox.id;
    expect(created.sandbox.lastExit).toBeNull();
    // The pids cgroup takes down the sentry — exit 2, no OOM flag — and no
    // reconcile runs before the next acquire.
    executor.crashContainer(id, {
      exitCode: 2,
      oomKilled: false,
      runtimeDied: true,
    });

    const res = await acquire(app, { name: 'alice' });
    expect(res.statusCode).toBe(200);
    const again = res.json();
    expect(again.status).toBe('ready');
    expect(again.created).toBe(false);
    expect(again.sandbox.id).toBe(id);
    expect(again.sandbox.state).toBe('active');
    // ready means running — the container, not the ledger.
    expect(executor.stateOf(id)).toBe('running');
    // The death travels on the wire: the caller who saw EOF reads why.
    expect(again.sandbox.lastExit).toMatchObject({
      exitCode: 2,
      cause: 'runtime-died',
    });
    expect(again.sandbox.lastExit.at).toMatch(/^\d{4}-/);
  });

  it('lastExit is sticky history: a later idle stop and wake keep the last death readable', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (
      await acquire(app, {
        name: 'alice',
        policy: { freezeAfterSeconds: 60, stopAfterSeconds: 120 },
      })
    ).json();
    const id = created.sandbox.id;
    executor.crashContainer(id, {
      exitCode: 137,
      oomKilled: true,
      runtimeDied: false,
    });
    const revived = (await acquire(app, { name: 'alice' })).json();
    expect(revived.sandbox.lastExit.cause).toBe('oom-killed');

    // The scanner's own stop is not a death and does not touch lastExit.
    const t = revived.sandbox.lastActiveAt;
    await scanOnce(db, executor, locks, after(t, 60));
    await scanOnce(db, executor, locks, after(t, 120));
    expect(executor.stateOf(id)).toBe('stopped');
    const listed = (await rpc(app, '/listSandboxes'))
      .json()
      .sandboxes.find((s: { id: string }) => s.id === id);
    expect(listed.state).toBe('stopped');
    expect(listed.lastExit).toMatchObject({
      exitCode: 137,
      cause: 'oom-killed',
    });

    const woken = (await acquire(app, { name: 'alice' })).json();
    expect(woken.sandbox.state).toBe('active');
    expect(woken.sandbox.lastExit).toMatchObject({
      exitCode: 137,
      cause: 'oom-killed',
    });
  });

  it('execCommand on a dead-but-active sandbox revives it instead of failing', async () => {
    const { app, executor } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();
    executor.crashContainer(created.sandbox.id, {
      exitCode: 137,
      oomKilled: true,
      runtimeDied: false,
    });
    const res = await rpc(app, '/execCommand', {
      name: 'alice',
      command: 'echo back',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stdout).toBe('back\n');
    expect(executor.stateOf(created.sandbox.id)).toBe('running');
  });
});

describe('POST /execCommand', () => {
  it('runs a command in the sandbox and returns the buffered result', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice' });
    // No timeoutSeconds sent: the schema default fills it in server-side.
    const res = await rpc(app, '/execCommand', {
      name: 'alice',
      command: 'echo hi',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      exitCode: 0,
      stdout: 'hi\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });

  it('answers an unknown key with a 404, never a silent create', async () => {
    const res = await rpc(testApp().app, '/execCommand', {
      name: 'nobody',
      command: 'echo hi',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/no sandbox named/);
  });

  it('wakes a frozen sandbox before running the command', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();
    const id = created.sandbox.id;
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

    // A paused container cannot even receive an exec (Docker refuses); the
    // route must wake it first, exactly like acquire does.
    const res = await rpc(app, '/execCommand', {
      name: 'alice',
      command: 'echo woke',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stdout).toBe('woke\n');
    expect(executor.stateOf(id)).toBe('running');
  });

  it('the heartbeat keeps a long-running command out of the freezer', async () => {
    // Reverse-verified: with startExecHeartbeat disabled this test goes
    // red (the sweep freezes the sandbox mid-sleep).
    const { app, db, executor, locks } = testApp();
    const created = (
      await acquire(app, {
        name: 'alice',
        policy: { freezeAfterSeconds: 1 },
      })
    ).json();
    const id = created.sandbox.id;

    // freeze:1 → heartbeat every 500ms. Sweep at real 700ms with a clock
    // reading 1.2s past the original lastActiveAt: exec's own start-of-exec
    // touch (~0ms) is stale against that clock — only the 500ms heartbeat
    // touch keeps the idle under the threshold.
    const execPromise = rpc(app, '/execCommand', {
      name: 'alice',
      command: 'sleep 1',
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const sweep = await scanOnce(
      db,
      executor,
      locks,
      after(created.sandbox.lastActiveAt, 1.2),
    );
    expect(sweep.frozen).toBe(0);
    expect(executor.stateOf(id)).toBe('running');

    const res = await execPromise;
    expect(res.statusCode).toBe(200);
    expect(res.json().exitCode).toBe(0);
  });

  it('a release mid-exec settles both requests and leaves the daemon alive', async () => {
    // Declared un-defended: the release wins, the exec answers honestly.
    // What this pins is the daemon's survival — the heartbeat touching a
    // deleted row must never become an unhandled throw inside setInterval.
    // Reverse-verified: without the heartbeat's try/catch this crashes.
    const { app } = testApp();
    await acquire(app, {
      name: 'alice',
      policy: { freezeAfterSeconds: 1 },
    });

    const execPromise = rpc(app, '/execCommand', {
      name: 'alice',
      command: 'sleep 1',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const releaseRes = await rpc(app, '/destroySandbox', {
      name: 'alice',
    });
    expect(releaseRes.json()).toEqual({ destroyed: true });

    // Both requests settle; ride out one more heartbeat interval on the
    // deleted row before declaring the daemon healthy.
    const execRes = await execPromise;
    expect(execRes.statusCode).toBeGreaterThanOrEqual(200);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const list = await rpc(app, '/listSandboxes');
    expect(list.statusCode).toBe(200);
    expect(list.json().sandboxes).toEqual([]);
  });

  it('rejects malformed requests with the protocol {message} shape', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice' });
    const bad = [
      { name: 'alice' }, // no command
      { name: 'alice', command: '' },
      { name: 'alice', command: 'echo hi', timeoutSeconds: 0 },
      { name: 'alice', command: 'echo hi', timeoutSeconds: -5 },
      { name: 'alice', command: 'echo hi', timeoutSeconds: 1.5 },
      { name: 'alice', command: 'echo hi', timeoutSeconds: 86_401 },
      { name: 'alice', command: 'echo hi', env: { PATH: 42 } },
    ];
    for (const payload of bad) {
      const res = await rpc(app, '/execCommand', payload);
      expect(res.statusCode).toBe(400);
      expect(Object.keys(res.json())).toEqual(['message']);
    }
  });
});

describe('POST /writeFiles and /readFile', () => {
  it('round-trips content through base64, resolving paths to absolute', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice' });
    // Every byte value: any utf8 coercion or base64 sloppiness breaks this.
    const bytes = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;

    const write = await rpc(app, '/writeFiles', {
      name: 'alice',
      files: [
        {
          path: 'notes.txt',
          contentBase64: Buffer.from('hi\n').toString('base64'),
        },
        {
          path: '/home/user/blob.bin',
          contentBase64: bytes.toString('base64'),
        },
      ],
    });
    expect(write.statusCode).toBe(200);
    expect(write.json()).toEqual({
      files: [
        { path: '/home/user/notes.txt' },
        { path: '/home/user/blob.bin' },
      ],
    });

    const read = await rpc(app, '/readFile', {
      name: 'alice',
      path: 'blob.bin',
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().path).toBe('/home/user/blob.bin');
    expect(Buffer.from(read.json().contentBase64, 'base64').equals(bytes)).toBe(
      true,
    );
  });

  it('answers an unknown key with a 404 on both verbs, never a silent create', async () => {
    const { app } = testApp();
    const write = await rpc(app, '/writeFiles', {
      name: 'nobody',
      files: [{ path: 'x', contentBase64: 'eA==' }],
    });
    expect(write.statusCode).toBe(404);
    const read = await rpc(app, '/readFile', {
      name: 'nobody',
      path: 'x',
    });
    expect(read.statusCode).toBe(404);
    expect(read.json().message).toMatch(/no sandbox named/);
  });

  it('wakes a frozen sandbox before touching files', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();
    await scanOnce(
      db,
      executor,
      locks,
      after(
        created.sandbox.lastActiveAt,
        DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
      ),
    );
    expect(executor.stateOf(created.sandbox.id)).toBe('paused');

    const res = await rpc(app, '/writeFiles', {
      name: 'alice',
      files: [{ path: 'woke.txt', contentBase64: 'eA==' }],
    });
    expect(res.statusCode).toBe(200);
    expect(executor.stateOf(created.sandbox.id)).toBe('running');
  });

  it('maps the typed file errors onto 404, 400 and 413', async () => {
    const { app, executor } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();

    const missing = await rpc(app, '/readFile', {
      name: 'alice',
      path: 'absent.txt',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toBe('no such file: /home/user/absent.txt');

    const directory = await rpc(app, '/readFile', {
      name: 'alice',
      path: '/home/user',
    });
    expect(directory.statusCode).toBe(400);
    expect(directory.json().message).toBe('not a regular file: /home/user');

    // Staged straight through the executor: its write path is deliberately
    // uncapped (the schema is the write-cap adjudicator), which is what
    // lets an over-limit file exist to be read.
    const size = FILE_SIZE_LIMIT_BYTES + 1;
    await executor.writeFiles(created.sandbox.id, [
      { path: 'big.bin', content: Buffer.alloc(size) },
    ]);
    const big = await rpc(app, '/readFile', {
      name: 'alice',
      path: 'big.bin',
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().message).toBe(
      `file too large: /home/user/big.bin is ${size} bytes, limit ${FILE_SIZE_LIMIT_BYTES}`,
    );
  });

  it('rejects an over-limit write with a 400 from the schema, not a body-limit 413', async () => {
    // One byte over, as base64 — ~21 MiB of body. Passing the raised route
    // bodyLimit and failing the per-file refine proves both gates sit where
    // they should: total bytes at the body limit, per-file size in the schema.
    const { app } = testApp();
    await acquire(app, { name: 'alice' });
    const res = await rpc(app, '/writeFiles', {
      name: 'alice',
      files: [
        {
          path: 'big.bin',
          contentBase64: Buffer.alloc(FILE_SIZE_LIMIT_BYTES + 3).toString(
            'base64',
          ),
        },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/exceeds the \d+-byte limit/);
  });

  it('rejects malformed requests with the protocol {message} shape', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice' });
    const bad = [
      ['/writeFiles', { name: 'alice', files: [] }],
      ['/writeFiles', { name: 'alice' }],
      [
        '/writeFiles',
        { name: 'alice', files: [{ path: '', contentBase64: 'eA==' }] },
      ],
      [
        '/writeFiles',
        {
          name: 'alice',
          files: [{ path: 'a\0b', contentBase64: 'eA==' }],
        },
      ],
      [
        '/writeFiles',
        {
          name: 'alice',
          files: [{ path: 'x', contentBase64: '!!not-b64' }],
        },
      ],
      ['/readFile', { name: 'alice' }],
      ['/readFile', { name: 'alice', path: '' }],
    ] as const;
    for (const [url, payload] of bad) {
      const res = await rpc(app, url, payload as Record<string, unknown>);
      expect(res.statusCode).toBe(400);
      expect(Object.keys(res.json())).toEqual(['message']);
    }
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
        name: 'alice',
        policy: { freezeAfterSeconds: 60 },
      })
    ).json();
    await acquire(app, { name: 'bob' });
    await scanOnce(db, executor, locks, after(alice.sandbox.lastActiveAt, 60));

    const res = await rpc(app, '/listSandboxes');
    expect(res.statusCode).toBe(200);
    const states = Object.fromEntries(
      res
        .json()
        .sandboxes.map((s: { name: string; state: string }) => [
          s.name,
          s.state,
        ]),
    );
    expect(states).toEqual({ alice: 'frozen', bob: 'active' });
  });
});

describe('POST /rebuildSandbox', () => {
  it('swaps the container, keeps the disk, and the same key wakes with its data', async () => {
    const { app, executor } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();
    const id = created.sandbox.id;
    await rpc(app, '/writeFiles', {
      name: 'alice',
      files: [
        {
          path: 'keep.txt',
          contentBase64: Buffer.from('survives').toString('base64'),
        },
      ],
    });

    const res = await rpc(app, '/rebuildSandbox', { name: 'alice' });
    expect(res.statusCode).toBe(200);
    // The shell is gone, the row stays, the state says so honestly.
    expect(res.json().sandbox).toMatchObject({
      id,
      state: 'stopped',
    });
    expect(executor.stateOf(id)).toBeUndefined();

    // The same key comes back to the same sandbox — rebuilt shell, same body.
    const again = (await acquire(app, { name: 'alice' })).json();
    expect(again.sandbox.id).toBe(id);
    const read = await rpc(app, '/readFile', {
      name: 'alice',
      path: 'keep.txt',
    });
    expect(Buffer.from(read.json().contentBase64, 'base64').toString()).toBe(
      'survives',
    );
  });

  it('rebuilds a frozen sandbox too, and again while already stopped', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();
    await scanOnce(
      db,
      executor,
      locks,
      after(
        created.sandbox.lastActiveAt,
        DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
      ),
    );
    expect(executor.stateOf(created.sandbox.id)).toBe('paused');

    const res = await rpc(app, '/rebuildSandbox', { name: 'alice' });
    expect(res.json().sandbox.state).toBe('stopped');

    // A second rebuild finds no container — the goal state, not an error.
    const again = await rpc(app, '/rebuildSandbox', { name: 'alice' });
    expect(again.statusCode).toBe(200);
    expect(again.json().sandbox.state).toBe('stopped');
  });

  it('answers 404 for an unknown key — rebuild is not a creator', async () => {
    const res = await rpc(testApp().app, '/rebuildSandbox', {
      name: 'nobody',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/acquire it first/);
  });
});

describe('POST /updatePolicy', () => {
  it('patches one knob, keeps the rest, and does not refresh the idle clock', async () => {
    const { app } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();

    const res = await rpc(app, '/updatePolicy', {
      name: 'alice',
      policy: { freezeAfterSeconds: 120 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sandbox.policy).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      freezeAfterSeconds: 120,
    });
    // Adjusting a knob is not activity: the idle countdown keeps running.
    expect(res.json().sandbox.lastActiveAt).toBe(created.sandbox.lastActiveAt);
  });

  it('promotes a frozen sandbox to never-stop without waking it', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();
    await scanOnce(
      db,
      executor,
      locks,
      after(
        created.sandbox.lastActiveAt,
        DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
      ),
    );
    expect(executor.stateOf(created.sandbox.id)).toBe('paused');

    const res = await rpc(app, '/updatePolicy', {
      name: 'alice',
      policy: { stopAfterSeconds: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sandbox.policy.stopAfterSeconds).toBeNull();
    // Ledger-only: the sandbox slept through its own promotion.
    expect(res.json().sandbox.state).toBe('frozen');
    expect(executor.stateOf(created.sandbox.id)).toBe('paused');
  });

  it('rejects a patch whose merged result breaks the ordering rule', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice' });
    // freeze pushed past the stored stop threshold.
    const res = await rpc(app, '/updatePolicy', {
      name: 'alice',
      policy: {
        freezeAfterSeconds:
          (DEFAULT_LIFECYCLE_POLICY.stopAfterSeconds ?? 0) + 1,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/stopAfterSeconds/);
  });

  it('refuses to promise archiving on a daemon without S3', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice' });
    const res = await rpc(app, '/updatePolicy', {
      name: 'alice',
      policy: { archiveAfterSeconds: 30 * 24 * 60 * 60 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(
      /archiving requires an S3 archive store/,
    );
  });

  it('answers 404 for an unknown key — updatePolicy is not a creator', async () => {
    const res = await rpc(testApp().app, '/updatePolicy', {
      name: 'nobody',
      policy: { freezeAfterSeconds: 60 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/acquire it first/);
  });

  it('treats a no-change patch as the goal state', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice' });
    const res = await rpc(app, '/updatePolicy', {
      name: 'alice',
      policy: {
        freezeAfterSeconds: DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /updateMetadata', () => {
  it('replaces the label set wholesale and does not refresh the idle clock', async () => {
    const { app } = testApp();
    const created = (
      await acquire(app, {
        name: 'alice',
        metadata: { app: 'crawler', env: 'staging' },
      })
    ).json();

    // Full replacement: env is gone, not merged.
    const res = await rpc(app, '/updateMetadata', {
      name: 'alice',
      metadata: { app: 'assistant' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sandbox.metadata).toEqual({ app: 'assistant' });
    // Relabeling is not activity: the idle countdown keeps running.
    expect(res.json().sandbox.lastActiveAt).toBe(created.sandbox.lastActiveAt);
  });

  it('clears every label with {}', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice', metadata: { app: 'crawler' } });
    const res = await rpc(app, '/updateMetadata', {
      name: 'alice',
      metadata: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sandbox.metadata).toEqual({});
  });

  it('relabels a frozen sandbox without waking it — a pure ledger write', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();
    await scanOnce(
      db,
      executor,
      locks,
      after(
        created.sandbox.lastActiveAt,
        DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
      ),
    );
    expect(executor.stateOf(created.sandbox.id)).toBe('paused');

    const res = await rpc(app, '/updateMetadata', {
      name: 'alice',
      metadata: { team: 'blue' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sandbox.state).toBe('frozen');
    expect(executor.stateOf(created.sandbox.id)).toBe('paused');
  });

  it('answers 404 for an unknown key — updateMetadata is not a creator', async () => {
    const res = await rpc(testApp().app, '/updateMetadata', {
      name: 'nobody',
      metadata: { app: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/acquire it first/);
  });

  it('treats a no-change replacement as the goal state', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice', metadata: { app: 'crawler' } });
    const res = await rpc(app, '/updateMetadata', {
      name: 'alice',
      metadata: { app: 'crawler' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /updateTemplate', () => {
  it('re-homes the sandbox and does not refresh the idle clock', async () => {
    const { app } = testApp(new FakeExecutor(), {
      templates: [
        { name: 'py-a', image: 'img-a' },
        { name: 'py-b', image: 'img-b' },
      ],
    });
    const created = (
      await acquire(app, { name: 'alice', template: 'py-a' })
    ).json();

    const res = await rpc(app, '/updateTemplate', {
      name: 'alice',
      template: 'py-b',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sandbox.template).toBe('py-b');
    // Re-homing is not activity: the idle countdown keeps running.
    expect(res.json().sandbox.lastActiveAt).toBe(created.sandbox.lastActiveAt);
  });

  it('a frozen sandbox stays frozen; the next wake swaps the shell onto the new template, data intact', async () => {
    const { app, db, executor, locks } = testApp(new FakeExecutor(), {
      templates: [
        { name: 'py-a', image: 'img-a' },
        { name: 'py-b', image: 'img-b' },
      ],
    });
    const created = (
      await acquire(app, { name: 'alice', template: 'py-a' })
    ).json().sandbox;
    await rpc(app, '/writeFiles', {
      name: 'alice',
      files: [
        {
          path: 'keep.txt',
          contentBase64: Buffer.from('survives').toString('base64'),
        },
      ],
    });
    const current = findById(db, created.id);
    if (!current) throw new Error('sandbox disappeared after write');
    await scanOnce(
      db,
      executor,
      locks,
      after(current.lastActiveAt, DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds),
    );
    expect(executor.stateOf(created.id)).toBe('paused');

    // A pure ledger write: the paused shell is not touched.
    const res = await rpc(app, '/updateTemplate', {
      name: 'alice',
      template: 'py-b',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sandbox.state).toBe('frozen');
    expect(executor.stateOf(created.id)).toBe('paused');
    expect(await executor.imageOf(created.id)).toBe('img-a');

    // The wake realizes the move: new shell from the new template, old body.
    const woken = (await acquire(app, { name: 'alice' })).json().sandbox;
    expect(woken.id).toBe(created.id);
    expect(await executor.imageOf(created.id)).toBe('img-b');
    const read = await rpc(app, '/readFile', {
      name: 'alice',
      path: 'keep.txt',
    });
    expect(Buffer.from(read.json().contentBase64, 'base64').toString()).toBe(
      'survives',
    );
  });

  it('null detaches back to the base image', async () => {
    const { app } = testApp(new FakeExecutor(), {
      templates: [{ name: 'py-a', image: 'img-a' }],
    });
    await acquire(app, { name: 'alice', template: 'py-a' });

    const res = await rpc(app, '/updateTemplate', {
      name: 'alice',
      template: null,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sandbox.template).toBeNull();
    // With no rows referencing it, the gateway's removal guard — which
    // asks this node — finds nobody: the migration story this verb exists for.
    expect((await rpc(app, '/templateUsers', { name: 'py-a' })).json()).toEqual(
      { sandboxNames: [] },
    );
  });

  it('rejects an unknown template with 400 and an unknown key with 404', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice' });
    const unknown = await rpc(app, '/updateTemplate', {
      name: 'alice',
      template: 'ghost',
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().message).toBe(
      "unknown template 'ghost' — register it first",
    );
    const nobody = await rpc(app, '/updateTemplate', {
      name: 'nobody',
      template: null,
    });
    expect(nobody.statusCode).toBe(404);
    expect(nobody.json().message).toMatch(/acquire it first/);
  });

  it('treats a same-template update as the goal state', async () => {
    const { app } = testApp(new FakeExecutor(), {
      templates: [{ name: 'py-a', image: 'img-a' }],
    });
    await acquire(app, { name: 'alice', template: 'py-a' });
    const res = await rpc(app, '/updateTemplate', {
      name: 'alice',
      template: 'py-a',
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /destroySandbox', () => {
  it('destroys the container and forgets the key', async () => {
    const { app, executor } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();
    const id = created.sandbox.id;

    const res = await rpc(app, '/destroySandbox', { name: 'alice' });
    expect(res.json()).toEqual({ destroyed: true });
    // Reality and ledger agree: container gone, key free again — the next
    // acquire builds a brand-new sandbox.
    expect(executor.stateOf(id)).toBeUndefined();
    const again = (await acquire(app, { name: 'alice' })).json();
    expect(again.sandbox.id).not.toBe(id);
  });

  it('releases a cold sandbox too', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();
    await scanOnce(
      db,
      executor,
      locks,
      after(
        created.sandbox.lastActiveAt,
        DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
      ),
    );
    expect(executor.stateOf(created.sandbox.id)).toBe('paused');

    const res = await rpc(app, '/destroySandbox', { name: 'alice' });
    expect(res.json()).toEqual({ destroyed: true });
    expect(executor.stateOf(created.sandbox.id)).toBeUndefined();
  });

  it('is idempotent: a key with no sandbox reports released false', async () => {
    const res = await rpc(testApp().app, '/destroySandbox', {
      name: 'nobody',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ destroyed: false });
  });
});

describe('the archiver through the app', () => {
  /**
   * testApp plus a MemStore-backed archiver — the S3-configured node. The
   * copy's S3 store is what flips the live adjudication (archiveEnabled);
   * the MemStore stands in for the S3 those settings describe, so the
   * routes' answer and the archiver's plumbing agree.
   */
  function archiverTestApp(executor: FakeExecutor = new FakeExecutor()) {
    const db = openDb(':memory:');
    migrateDb(db, MIGRATIONS);
    const config = loadConfig({
      DORMICE_DB_PATH: ':memory:',
      DORMICE_NODE_ID: 'node-test',
      DORMICE_API_TOKEN: TOKEN,
    });
    configureNode(db, { s3: TEST_S3 });
    const locks = new KeyedQueue();
    const store = new MemStore();
    const archiver = new Archiver({
      db,
      executor,
      locks,
      store,
      tmpDir: mkdtempSync(path.join(tmpdir(), 'dormice-app-')),
    });
    const app = buildApp({
      config,
      db,
      executor,
      locks,
      logger: false,
      archiver,
    });
    return { app, db, executor, locks, store, archiver };
  }

  /** Polls acquire until the union flips to ready; the whole restore path. */
  async function acquireUntilReady(
    app: ReturnType<typeof testApp>['app'],
    name: string,
  ) {
    const deadline = Date.now() + 5_000;
    while (true) {
      const body = (await acquire(app, { name })).json();
      // Only an already-archived sandbox restores, and the ready it lands
      // on is a wake — no arm of this poll loop may ever claim `created`.
      expect(body.created).toBe(false);
      if (body.status === 'ready') return body;
      expect(body.status).toBe('restoring');
      expect(body.progress.phase).toMatch(/downloading|extracting/);
      if (Date.now() > deadline) {
        throw new Error(`still restoring: ${JSON.stringify(body)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('runs the full cold cycle: archive by idleness, restore by acquire', async () => {
    const { app, db, executor, locks, store, archiver } = archiverTestApp();
    const created = (
      await acquire(app, {
        name: 'alice',
        policy: {
          freezeAfterSeconds: 1,
          stopAfterSeconds: 2,
          archiveAfterSeconds: 3,
        },
      })
    ).json();
    const id = created.sandbox.id;
    await rpc(app, '/writeFiles', {
      name: 'alice',
      files: [
        {
          path: 'kept.txt',
          contentBase64: Buffer.from('through the archive').toString('base64'),
        },
      ],
    });
    const { lastActiveAt } = (await rpc(app, '/listSandboxes')).json()
      .sandboxes[0];

    // Three sweeps, one rung each: frozen, stopped, archived.
    await scanOnce(db, executor, locks, after(lastActiveAt, 1), archiver);
    await scanOnce(db, executor, locks, after(lastActiveAt, 2), archiver);
    await scanOnce(db, executor, locks, after(lastActiveAt, 3), archiver);
    const listed = (await rpc(app, '/listSandboxes')).json().sandboxes[0];
    expect(listed.state).toBe('archived');
    expect(store.has(objectKey(id))).toBe(true);
    expect(executor.stateOf(id)).toBeUndefined();
    expect(await executor.listDisks()).not.toContain(id);

    // The re-acquire begins the restore and answers restoring immediately;
    // polling lands on ready with the same sandbox and its data intact.
    const ready = await acquireUntilReady(app, 'alice');
    expect(ready.sandbox.id).toBe(id);
    expect(ready.sandbox.state).toBe('active');
    const read = (
      await rpc(app, '/readFile', { name: 'alice', path: 'kept.txt' })
    ).json();
    expect(Buffer.from(read.contentBase64, 'base64').toString()).toBe(
      'through the archive',
    );
  });

  it('stores the 7-day archive default when S3 is configured', async () => {
    const { app } = archiverTestApp();
    const res = await acquire(app, { name: 'alice' });
    expect(res.json().sandbox.policy.archiveAfterSeconds).toBe(
      ARCHIVE_DEFAULT_SECONDS,
    );
  });

  it('answers 503 for an archived sandbox on a daemon without S3', async () => {
    // The operator archived with S3 configured, then rebooted without it:
    // the rows are honest, the restore is impossible, the error names it.
    const executor = new FakeExecutor();
    const { app, db } = testApp(executor);
    const created = (await acquire(app, { name: 'alice' })).json();
    const id = created.sandbox.id;
    transition(db, id, 'frozen');
    transition(db, id, 'stopped');
    transition(db, id, 'archived');
    await executor.destroy(id);

    const res = await acquire(app, { name: 'alice' });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/no S3 archive store is configured/);
  });

  it('release of an archived sandbox deletes the S3 object and the row', async () => {
    const { app, db, executor, locks, store, archiver } = archiverTestApp();
    const created = (
      await acquire(app, {
        name: 'alice',
        policy: {
          freezeAfterSeconds: 1,
          stopAfterSeconds: 2,
          archiveAfterSeconds: 3,
        },
      })
    ).json();
    const id = created.sandbox.id;
    const stamp = created.sandbox.lastActiveAt;
    await scanOnce(db, executor, locks, after(stamp, 1), archiver);
    await scanOnce(db, executor, locks, after(stamp, 2), archiver);
    await scanOnce(db, executor, locks, after(stamp, 3), archiver);
    expect(store.has(objectKey(id))).toBe(true);

    const res = await rpc(app, '/destroySandbox', { name: 'alice' });
    expect(res.json()).toEqual({ destroyed: true });
    expect(store.has(objectKey(id))).toBe(false);
    expect((await rpc(app, '/listSandboxes')).json().sandboxes).toEqual([]);
  });

  it('answers 409 for a release while the restore runs', async () => {
    const { app, db, executor, locks, store, archiver } = archiverTestApp();
    const created = (
      await acquire(app, {
        name: 'alice',
        policy: {
          freezeAfterSeconds: 1,
          stopAfterSeconds: 2,
          archiveAfterSeconds: 3,
        },
      })
    ).json();
    const stamp = created.sandbox.lastActiveAt;
    await scanOnce(db, executor, locks, after(stamp, 1), archiver);
    await scanOnce(db, executor, locks, after(stamp, 2), archiver);
    await scanOnce(db, executor, locks, after(stamp, 3), archiver);
    // Hold the download open so the sandbox is mid-restoring for the test.
    let releaseDownload!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const innerGet = store.get.bind(store);
    store.get = async (key, dest, onProgress) => {
      await gate;
      return innerGet(key, dest, onProgress);
    };

    const restoring = (await acquire(app, { name: 'alice' })).json();
    expect(restoring.status).toBe('restoring');
    const res = await rpc(app, '/destroySandbox', { name: 'alice' });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/restoring; retry/);

    releaseDownload();
    await acquireUntilReady(app, 'alice');
  });

  it('answers 409 for exec and file verbs on an archived sandbox', async () => {
    const { app, db, executor, locks, archiver } = archiverTestApp();
    const created = (
      await acquire(app, {
        name: 'alice',
        policy: {
          freezeAfterSeconds: 1,
          stopAfterSeconds: 2,
          archiveAfterSeconds: 3,
        },
      })
    ).json();
    const stamp = created.sandbox.lastActiveAt;
    await scanOnce(db, executor, locks, after(stamp, 1), archiver);
    await scanOnce(db, executor, locks, after(stamp, 2), archiver);
    await scanOnce(db, executor, locks, after(stamp, 3), archiver);

    const exec = await rpc(app, '/execCommand', {
      name: 'alice',
      command: 'echo hi',
    });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().message).toMatch(/call acquireSandbox and poll/);
    const read = await rpc(app, '/readFile', {
      name: 'alice',
      path: 'kept.txt',
    });
    expect(read.statusCode).toBe(409);
  });
});

describe('templates on the node: the copy at work', () => {
  it('acquire with a template creates the sandbox from its image and records the name', async () => {
    const { app, executor } = testApp(new FakeExecutor(), {
      templates: [{ name: 'py', image: 'img-a' }],
    });
    const res = await acquire(app, { name: 'alice', template: 'py' });
    expect(res.statusCode).toBe(200);
    const sandbox = res.json().sandbox;
    expect(sandbox.template).toBe('py');
    // The physical half: the shell was actually born from the template's image.
    expect(await executor.imageOf(sandbox.id)).toBe('img-a');
    // A template-less acquire stays on the base image, template null.
    const plain = (await acquire(app, { name: 'bob' })).json().sandbox;
    expect(plain.template).toBeNull();
  });

  it('rejects an unknown template with 400, on the wake path too', async () => {
    const { app } = testApp();
    const res = await acquire(app, { name: 'alice', template: 'ghost' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe(
      "unknown template 'ghost' — register it first",
    );
    // Same answer when the key already has a sandbox: the caller's mistake
    // deserves a 400 even when the value would not apply.
    await acquire(app, { name: 'bob' });
    const wake = await acquire(app, { name: 'bob', template: 'ghost' });
    expect(wake.statusCode).toBe(400);
  });

  it('a valid template on an existing key is not applied — creation-time only', async () => {
    const { app } = testApp(new FakeExecutor(), {
      templates: [{ name: 'py', image: 'img-a' }],
    });
    const created = (await acquire(app, { name: 'alice' })).json().sandbox;
    expect(created.template).toBeNull();
    const again = (await acquire(app, { name: 'alice', template: 'py' })).json()
      .sandbox;
    expect(again.id).toBe(created.id);
    expect(again.template).toBeNull();
  });

  it("templateUsers names the sandboxes still on a template — the gateway's removal guard asks this", async () => {
    const { app } = testApp(new FakeExecutor(), {
      templates: [{ name: 'py', image: 'img-a' }],
    });
    await acquire(app, { name: 'alice', template: 'py' });
    await acquire(app, { name: 'bob', template: 'py' });
    await acquire(app, { name: 'carol' });

    const users = await rpc(app, '/templateUsers', { name: 'py' });
    expect(users.statusCode).toBe(200);
    expect(users.json().sandboxNames.sort()).toEqual(['alice', 'bob']);
    // A name nobody uses, and a name that is no template at all: both an
    // honest empty list — the question is about this ledger's rows.
    await rpc(app, '/destroySandbox', { name: 'alice' });
    await rpc(app, '/destroySandbox', { name: 'bob' });
    expect((await rpc(app, '/templateUsers', { name: 'py' })).json()).toEqual({
      sandboxNames: [],
    });
    expect(
      (await rpc(app, '/templateUsers', { name: 'ghost' })).json(),
    ).toEqual({ sandboxNames: [] });
    // Like every native verb, behind the token; and a malformed name is a 400.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/templateUsers',
          payload: { name: 'py' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await rpc(app, '/templateUsers', { name: '-bad' })).statusCode,
    ).toBe(400);
  });

  it('re-point then rebuild moves the sandbox onto the new image — the immediate front door', async () => {
    const { app, db, executor } = testApp(new FakeExecutor(), {
      templates: [{ name: 'py', image: 'img-v1' }],
    });
    const created = (
      await acquire(app, { name: 'alice', template: 'py' })
    ).json().sandbox;
    expect(await executor.imageOf(created.id)).toBe('img-v1');

    // Operator builds a new image and re-points the name at the gateway;
    // the next bundle brings it here. A running shell is never touched
    // behind the sandbox's back — the stock moves on an explicit rebuild
    // (here) or on the next cold wake (tests below).
    registerTestTemplate(db, 'py', 'img-v2');
    expect(await executor.imageOf(created.id)).toBe('img-v1');

    await rpc(app, '/rebuildSandbox', { name: 'alice' });
    const woken = (await acquire(app, { name: 'alice' })).json().sandbox;
    expect(woken.id).toBe(created.id);
    // The rebuilt shell was born from the template's *current* image.
    expect(await executor.imageOf(created.id)).toBe('img-v2');
  });
});

describe('cold wakes converge onto the current image', () => {
  it('frozen + stale: the wake swaps the shell, keeps the data, and records the swap', async () => {
    const { app, db, executor, locks } = testApp(new FakeExecutor(), {
      templates: [{ name: 'py', image: 'img-v1' }],
    });
    const created = (
      await acquire(app, { name: 'alice', template: 'py' })
    ).json().sandbox;
    await rpc(app, '/writeFiles', {
      name: 'alice',
      files: [
        {
          path: 'keep.txt',
          contentBase64: Buffer.from('survives').toString('base64'),
        },
      ],
    });
    const current = findById(db, created.id);
    if (!current) throw new Error('sandbox disappeared after write');
    const sweep = await scanOnce(
      db,
      executor,
      locks,
      after(current.lastActiveAt, DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds),
    );
    expect(sweep.frozen).toBe(1);
    expect(sweep.failures).toEqual([]);
    expect(executor.stateOf(created.id)).toBe('paused');

    registerTestTemplate(db, 'py', 'img-v2');
    const woken = (await acquire(app, { name: 'alice' })).json().sandbox;
    expect(woken.id).toBe(created.id);
    expect(woken.state).toBe('active');
    // The new shell, the old body.
    expect(await executor.imageOf(created.id)).toBe('img-v2');
    const read = await rpc(app, '/readFile', {
      name: 'alice',
      path: 'keep.txt',
    });
    expect(Buffer.from(read.json().contentBase64, 'base64').toString()).toBe(
      'survives',
    );
    // The old shell was removed — a swap, not a plain unpause.
    expect(executor.removedShells).toEqual([created.id]);
  });

  it('frozen + fresh: a plain unpause, no shell removed', async () => {
    const { app, db, executor, locks } = testApp(new FakeExecutor(), {
      templates: [{ name: 'py', image: 'img-v1' }],
    });
    const created = (
      await acquire(app, { name: 'alice', template: 'py' })
    ).json().sandbox;
    await scanOnce(
      db,
      executor,
      locks,
      after(created.lastActiveAt, DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds),
    );

    const woken = (await acquire(app, { name: 'alice' })).json().sandbox;
    expect(woken.state).toBe('active');
    expect(await executor.imageOf(created.id)).toBe('img-v1');
    expect(executor.removedShells).toEqual([]);
  });

  it('stopped + stale: the same convergence — stop kept the old shell, the wake replaces it', async () => {
    const { app, db, executor, locks } = testApp(new FakeExecutor(), {
      templates: [{ name: 'py', image: 'img-v1' }],
    });
    const created = (
      await acquire(app, {
        name: 'alice',
        template: 'py',
        policy: { freezeAfterSeconds: 60, stopAfterSeconds: 120 },
      })
    ).json().sandbox;
    await scanOnce(db, executor, locks, after(created.lastActiveAt, 60));
    await scanOnce(db, executor, locks, after(created.lastActiveAt, 120));
    // The stopped container object survives, still born from the old image.
    expect(executor.stateOf(created.id)).toBe('stopped');
    expect(await executor.imageOf(created.id)).toBe('img-v1');

    registerTestTemplate(db, 'py', 'img-v2');
    const woken = (await acquire(app, { name: 'alice' })).json().sandbox;
    expect(woken.state).toBe('active');
    expect(await executor.imageOf(created.id)).toBe('img-v2');
    expect(executor.removedShells).toEqual([created.id]);
  });

  it('a template-less sandbox is judged against the base image — fresh, so untouched', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json().sandbox;
    await scanOnce(
      db,
      executor,
      locks,
      after(created.lastActiveAt, DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds),
    );

    const woken = (await acquire(app, { name: 'alice' })).json().sandbox;
    expect(woken.state).toBe('active');
    expect(await executor.imageOf(created.id)).toBe(executor.baseImage);
    expect(executor.removedShells).toEqual([]);
  });

  it('a vanished shell is not judged stale — the start builds from the current image by itself', async () => {
    const { app, db, executor, locks } = testApp(new FakeExecutor(), {
      templates: [{ name: 'py', image: 'img-v1' }],
    });
    const created = (
      await acquire(app, {
        name: 'alice',
        template: 'py',
        policy: { freezeAfterSeconds: 60, stopAfterSeconds: 120 },
      })
    ).json().sandbox;
    await scanOnce(db, executor, locks, after(created.lastActiveAt, 60));
    await scanOnce(db, executor, locks, after(created.lastActiveAt, 120));
    executor.vanishContainer(created.id);

    registerTestTemplate(db, 'py', 'img-v2');
    const woken = (await acquire(app, { name: 'alice' })).json().sandbox;
    expect(woken.state).toBe('active');
    // Converged all the same, but through start's own rebuild — no shell
    // was removed, so no 'rebuilt' entry claims one was.
    expect(await executor.imageOf(created.id)).toBe('img-v2');
    expect(executor.removedShells).toEqual([]);
  });
});

describe('POST /getHostMetrics', () => {
  it('sits behind the token like every API verb', async () => {
    const res = await testApp().app.inject({
      method: 'POST',
      url: '/getHostMetrics',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('answers a schema-valid snapshot with honest host readings', async () => {
    // tmpdir() exists on every platform, so the data-disk reading is real.
    const { app } = testApp(
      new FakeExecutor(),
      {},
      {
        DORMICE_DATA_DIR: tmpdir(),
      },
    );
    const res = await rpc(app, '/getHostMetrics');
    expect(res.statusCode).toBe(200);
    const body = hostMetricsResponseSchema.parse(res.json());
    expect(body.host.cpuCount).toBeGreaterThan(0);
    expect(body.host.memTotalBytes).toBeGreaterThan(0);
    expect(body.host.memAvailableBytes).toBeGreaterThan(0);
    expect(body.dataDisk?.path).toBe(tmpdir());
    expect(body.dataDisk?.totalBytes).toBeGreaterThan(0);
    expect(body.sandboxes).toEqual({
      total: 0,
      byState: { active: 0, frozen: 0, stopped: 0, archived: 0, restoring: 0 },
    });
    expect(body.sandboxDisks).toEqual({
      count: 0,
      nominalBytes: 0,
      actualBytes: 0,
    });
  });

  it('reports a missing data dir as null — absent, not invented', async () => {
    const { app } = testApp(
      new FakeExecutor(),
      {},
      {
        DORMICE_DATA_DIR: '/no/such/dormice-data',
      },
    );
    const res = await rpc(app, '/getHostMetrics');
    expect(res.statusCode).toBe(200);
    expect(res.json().dataDisk).toBeNull();
  });

  it('aggregates follow the ledger, and observing changes nothing', async () => {
    const { app, db, executor, locks } = testApp();
    // alice freezes after 60s, bob keeps the 600s default: time-traveling
    // to alice+60 freezes exactly one of them.
    const created = (
      await acquire(app, {
        name: 'alice',
        policy: { freezeAfterSeconds: 60 },
      })
    ).json();
    await acquire(app, { name: 'bob' });

    let body = (await rpc(app, '/getHostMetrics')).json();
    expect(body.sandboxes.total).toBe(2);
    expect(body.sandboxes.byState.active).toBe(2);
    expect(body.sandboxDisks.count).toBe(2);
    expect(body.sandboxDisks.nominalBytes).toBeGreaterThan(0);
    expect(body.sandboxDisks.actualBytes).toBeGreaterThan(0);

    await scanOnce(
      db,
      executor,
      locks,
      after(created.sandbox.lastActiveAt, 60),
    );
    body = (await rpc(app, '/getHostMetrics')).json();
    expect(body.sandboxes.byState.active).toBe(1);
    expect(body.sandboxes.byState.frozen).toBe(1);
    // Observation is not activity: reading metrics woke nothing.
    expect(executor.stateOf(created.sandbox.id)).toBe('paused');
  });
});

describe('POST /lookupSandbox', () => {
  it('answers by name and by id with the state, without waking or touching the idle clock', async () => {
    const { app, db } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();
    const row = findById(db, created.sandbox.id);
    if (!row) throw new Error('no row');
    // A cold sandbox stays cold: lookup is observation, not use.
    transition(db, row.id, 'frozen');

    const byName = await rpc(app, '/lookupSandbox', { name: 'alice' });
    expect(byName.statusCode).toBe(200);
    expect(byName.json()).toEqual({
      found: true,
      sandbox: { id: row.id, name: 'alice', state: 'frozen' },
    });
    const byId = await rpc(app, '/lookupSandbox', { id: row.id });
    expect(byId.json()).toEqual(byName.json());
    expect(findById(db, row.id)?.state).toBe('frozen');
    expect(findById(db, row.id)?.lastActiveAt).toBe(row.lastActiveAt);

    expect(
      (await rpc(app, '/lookupSandbox', { name: 'nobody' })).json(),
    ).toEqual({ found: false });
    expect(
      (await rpc(app, '/lookupSandbox', { id: 'no-such-id' })).json(),
    ).toEqual({ found: false });
    // Neither a name nor an id is not a question.
    expect((await rpc(app, '/lookupSandbox', {})).statusCode).toBe(400);
  });

  it('a name whose slot is busy waits its turn: asked while an acquire is mid-create, it answers found once the row exists', async () => {
    // A create that parks inside the executor — the daemon's own shape of
    // "in flight": the acquire holds the name's slot, the container is
    // being built, the row is not written yet.
    let release: () => void = () => {};
    let inCreate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      inCreate = resolve;
    });
    class ParkedCreate extends FakeExecutor {
      override async create(
        ...args: Parameters<FakeExecutor['create']>
      ): Promise<void> {
        inCreate();
        await gate;
        return super.create(...args);
      }
    }
    const { app } = testApp(new ParkedCreate());
    const creating = acquire(app, { name: 'alice' });
    await reached;
    // No row, slot busy: the question must wait, not answer "no".
    const asked = rpc(app, '/lookupSandbox', { name: 'alice' });
    const early = await Promise.race([
      asked.then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);
    expect(early).toBe('pending');
    release();
    const created = (await creating).json();
    expect((await asked).json()).toEqual({
      found: true,
      sandbox: { id: created.sandbox.id, name: 'alice', state: 'active' },
    });
  });

  it('a sandbox with a row answers at once even while its slot is held — a restore in progress must not read as silence', async () => {
    const { app, db, locks } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();
    transition(db, created.sandbox.id, 'frozen');
    transition(db, created.sandbox.id, 'stopped');
    transition(db, created.sandbox.id, 'archived');
    transition(db, created.sandbox.id, 'restoring');
    let release: () => void = () => {};
    const held = locks.run(
      'alice',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const answer = await Promise.race([
      rpc(app, '/lookupSandbox', { name: 'alice' }).then((r) => r.json()),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 500)),
    ]);
    expect(answer).toEqual({
      found: true,
      sandbox: { id: created.sandbox.id, name: 'alice', state: 'restoring' },
    });
    release();
    await held;
  });
});
