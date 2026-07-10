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
import { transition } from './db/ledger';
import { FakeExecutor } from './executor/fake';
import { KeyedQueue } from './keyed-queue';
import { ARCHIVE_DEFAULT_SECONDS } from './policy';
import { reconcile } from './reconciler';
import { scanOnce } from './scanner';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const TOKEN = 'test-token-test-token-test-token';

function testApp(
  executor: FakeExecutor = new FakeExecutor(),
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
      policy: { freezeAfterSeconds: 61, stopAfterSeconds: 60 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/freezeAfterSeconds/);
  });

  it('refuses an archive-asking policy when no S3 is configured', async () => {
    // Without an archiver a stored archive threshold would be a standing
    // lie; the daemon refuses rather than nodding along.
    const res = await acquire(testApp().app, {
      userKey: 'alice',
      policy: { archiveAfterSeconds: 3600 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(
      /archiving requires S3 \(DORMICE_S3_\*\)/,
    );
  });

  it('rejects a malformed body', async () => {
    const res = await acquire(testApp().app, { policy: {} });
    expect(res.statusCode).toBe(400);
  });

  it('stores stopAfterSeconds: null — the never-stop resident policy', async () => {
    const res = await acquire(testApp().app, {
      userKey: 'resident',
      policy: { stopAfterSeconds: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sandbox.policy.stopAfterSeconds).toBeNull();
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

describe('error shape', () => {
  it('answers validation failures with the protocol {message} body on every route', async () => {
    // releaseSandbox declares no error schema; without the global error
    // handler Fastify's native multi-field shape leaked here.
    const res = await rpc(testApp().app, '/releaseSandbox', {});
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json())).toEqual(['message']);
  });

  it('answers unknown routes with the same {message} shape', async () => {
    const res = await rpc(testApp().app, '/noSuchVerb');
    expect(res.statusCode).toBe(404);
    expect(Object.keys(res.json())).toEqual(['message']);
  });
});

describe('sandbox capacity', () => {
  it('caps creation at DORMICE_MAX_SANDBOXES with an honest 429', async () => {
    const { app } = testApp(undefined, { DORMICE_MAX_SANDBOXES: '1' });
    expect((await acquire(app, { userKey: 'alice' })).statusCode).toBe(200);

    const capped = await acquire(app, { userKey: 'bob' });
    expect(capped.statusCode).toBe(429);
    expect(capped.json().message).toMatch(/DORMICE_MAX_SANDBOXES/);

    // Existing sandboxes always wake — the cap only guards creation.
    expect((await acquire(app, { userKey: 'alice' })).statusCode).toBe(200);
    // Releasing frees the slot.
    await rpc(app, '/releaseSandbox', { userKey: 'alice' });
    expect((await acquire(app, { userKey: 'bob' })).statusCode).toBe(200);
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
    const created = (
      await acquire(app, {
        userKey: 'alice',
        policy: { freezeAfterSeconds: 60, stopAfterSeconds: 120 },
      })
    ).json();
    const id = created.sandbox.sandboxId;

    const lastActiveAt = created.sandbox.lastActiveAt;
    await scanOnce(db, executor, locks, after(lastActiveAt, 60));
    await scanOnce(db, executor, locks, after(lastActiveAt, 120));
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
    const created = (
      await acquire(app, {
        userKey: 'alice',
        policy: { freezeAfterSeconds: 60, stopAfterSeconds: 120 },
      })
    ).json();
    const id = created.sandbox.sandboxId;
    const lastActiveAt = created.sandbox.lastActiveAt;
    await scanOnce(db, executor, locks, after(lastActiveAt, 60));
    await scanOnce(db, executor, locks, after(lastActiveAt, 120));
    executor.vanishContainer(id);

    await reconcile(db, executor, locks, new Set());

    const again = (await acquire(app, { userKey: 'alice' })).json();
    expect(again.sandbox.sandboxId).toBe(id);
    expect(again.sandbox.state).toBe('active');
    expect(executor.stateOf(id)).toBe('running');
  });
});

describe('POST /execCommand', () => {
  it('runs a command in the sandbox and returns the buffered result', async () => {
    const { app } = testApp();
    await acquire(app, { userKey: 'alice' });
    // No timeoutSeconds sent: the schema default fills it in server-side.
    const res = await rpc(app, '/execCommand', {
      userKey: 'alice',
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
      userKey: 'nobody',
      command: 'echo hi',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/no sandbox for key/);
  });

  it('wakes a frozen sandbox before running the command', async () => {
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

    // A paused container cannot even receive an exec (Docker refuses); the
    // route must wake it first, exactly like acquire does.
    const res = await rpc(app, '/execCommand', {
      userKey: 'alice',
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
        userKey: 'alice',
        policy: { freezeAfterSeconds: 1 },
      })
    ).json();
    const id = created.sandbox.sandboxId;

    // freeze:1 → heartbeat every 500ms. Sweep at real 700ms with a clock
    // reading 1.2s past the original lastActiveAt: exec's own start-of-exec
    // touch (~0ms) is stale against that clock — only the 500ms heartbeat
    // touch keeps the idle under the threshold.
    const execPromise = rpc(app, '/execCommand', {
      userKey: 'alice',
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
      userKey: 'alice',
      policy: { freezeAfterSeconds: 1 },
    });

    const execPromise = rpc(app, '/execCommand', {
      userKey: 'alice',
      command: 'sleep 1',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const releaseRes = await rpc(app, '/releaseSandbox', { userKey: 'alice' });
    expect(releaseRes.json()).toEqual({ released: true });

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
    await acquire(app, { userKey: 'alice' });
    const bad = [
      { userKey: 'alice' }, // no command
      { userKey: 'alice', command: '' },
      { userKey: 'alice', command: 'echo hi', timeoutSeconds: 0 },
      { userKey: 'alice', command: 'echo hi', timeoutSeconds: -5 },
      { userKey: 'alice', command: 'echo hi', timeoutSeconds: 1.5 },
      { userKey: 'alice', command: 'echo hi', timeoutSeconds: 86_401 },
      { userKey: 'alice', command: 'echo hi', env: { PATH: 42 } },
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
    await acquire(app, { userKey: 'alice' });
    // Every byte value: any utf8 coercion or base64 sloppiness breaks this.
    const bytes = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;

    const write = await rpc(app, '/writeFiles', {
      userKey: 'alice',
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
      userKey: 'alice',
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
      userKey: 'nobody',
      files: [{ path: 'x', contentBase64: 'eA==' }],
    });
    expect(write.statusCode).toBe(404);
    const read = await rpc(app, '/readFile', { userKey: 'nobody', path: 'x' });
    expect(read.statusCode).toBe(404);
    expect(read.json().message).toMatch(/no sandbox for key/);
  });

  it('wakes a frozen sandbox before touching files', async () => {
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

    const res = await rpc(app, '/writeFiles', {
      userKey: 'alice',
      files: [{ path: 'woke.txt', contentBase64: 'eA==' }],
    });
    expect(res.statusCode).toBe(200);
    expect(executor.stateOf(created.sandbox.sandboxId)).toBe('running');
  });

  it('maps the typed file errors onto 404, 400 and 413', async () => {
    const { app, executor } = testApp();
    const created = (await acquire(app, { userKey: 'alice' })).json();

    const missing = await rpc(app, '/readFile', {
      userKey: 'alice',
      path: 'absent.txt',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toBe('no such file: /home/user/absent.txt');

    const directory = await rpc(app, '/readFile', {
      userKey: 'alice',
      path: '/home/user',
    });
    expect(directory.statusCode).toBe(400);
    expect(directory.json().message).toBe('not a regular file: /home/user');

    // Staged straight through the executor: its write path is deliberately
    // uncapped (the schema is the write-cap adjudicator), which is what
    // lets an over-limit file exist to be read.
    const size = FILE_SIZE_LIMIT_BYTES + 1;
    await executor.writeFiles(created.sandbox.sandboxId, [
      { path: 'big.bin', content: Buffer.alloc(size) },
    ]);
    const big = await rpc(app, '/readFile', {
      userKey: 'alice',
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
    await acquire(app, { userKey: 'alice' });
    const res = await rpc(app, '/writeFiles', {
      userKey: 'alice',
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
    await acquire(app, { userKey: 'alice' });
    const bad = [
      ['/writeFiles', { userKey: 'alice', files: [] }],
      ['/writeFiles', { userKey: 'alice' }],
      [
        '/writeFiles',
        { userKey: 'alice', files: [{ path: '', contentBase64: 'eA==' }] },
      ],
      [
        '/writeFiles',
        {
          userKey: 'alice',
          files: [{ path: 'a\0b', contentBase64: 'eA==' }],
        },
      ],
      [
        '/writeFiles',
        {
          userKey: 'alice',
          files: [{ path: 'x', contentBase64: '!!not-b64' }],
        },
      ],
      ['/readFile', { userKey: 'alice' }],
      ['/readFile', { userKey: 'alice', path: '' }],
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

describe('POST /rebuildSandbox', () => {
  it('swaps the container, keeps the disk, and the same key wakes with its data', async () => {
    const { app, executor } = testApp();
    const created = (await acquire(app, { userKey: 'alice' })).json();
    const id = created.sandbox.sandboxId;
    await rpc(app, '/writeFiles', {
      userKey: 'alice',
      files: [
        {
          path: 'keep.txt',
          contentBase64: Buffer.from('survives').toString('base64'),
        },
      ],
    });

    const res = await rpc(app, '/rebuildSandbox', { userKey: 'alice' });
    expect(res.statusCode).toBe(200);
    // The shell is gone, the row stays, the state says so honestly.
    expect(res.json().sandbox).toMatchObject({
      sandboxId: id,
      state: 'stopped',
    });
    expect(executor.stateOf(id)).toBeUndefined();

    // The same key comes back to the same sandbox — rebuilt shell, same body.
    const again = (await acquire(app, { userKey: 'alice' })).json();
    expect(again.sandbox.sandboxId).toBe(id);
    const read = await rpc(app, '/readFile', {
      userKey: 'alice',
      path: 'keep.txt',
    });
    expect(Buffer.from(read.json().contentBase64, 'base64').toString()).toBe(
      'survives',
    );
  });

  it('rebuilds a frozen sandbox too, and again while already stopped', async () => {
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

    const res = await rpc(app, '/rebuildSandbox', { userKey: 'alice' });
    expect(res.json().sandbox.state).toBe('stopped');

    // A second rebuild finds no container — the goal state, not an error.
    const again = await rpc(app, '/rebuildSandbox', { userKey: 'alice' });
    expect(again.statusCode).toBe(200);
    expect(again.json().sandbox.state).toBe('stopped');
  });

  it('answers 404 for an unknown key — rebuild is not a creator', async () => {
    const res = await rpc(testApp().app, '/rebuildSandbox', {
      userKey: 'nobody',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/acquire it first/);
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

describe('the archiver through the app', () => {
  /** testApp plus a MemStore-backed archiver — the S3-configured daemon. */
  function archiverTestApp(executor: FakeExecutor = new FakeExecutor()) {
    const db = openDb(':memory:');
    migrateDb(db, MIGRATIONS);
    const config = loadConfig({
      DORMICE_DB_PATH: ':memory:',
      DORMICE_NODE_ID: 'node-test',
      DORMICE_API_TOKEN: TOKEN,
    });
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
    userKey: string,
  ) {
    const deadline = Date.now() + 5_000;
    while (true) {
      const body = (await acquire(app, { userKey })).json();
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
        userKey: 'alice',
        policy: {
          freezeAfterSeconds: 1,
          stopAfterSeconds: 2,
          archiveAfterSeconds: 3,
        },
      })
    ).json();
    const id = created.sandbox.sandboxId;
    await rpc(app, '/writeFiles', {
      userKey: 'alice',
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
    expect(ready.sandbox.sandboxId).toBe(id);
    expect(ready.sandbox.state).toBe('active');
    const read = (
      await rpc(app, '/readFile', { userKey: 'alice', path: 'kept.txt' })
    ).json();
    expect(Buffer.from(read.contentBase64, 'base64').toString()).toBe(
      'through the archive',
    );
  });

  it('stores the 7-day archive default when S3 is configured', async () => {
    const { app } = archiverTestApp();
    const res = await acquire(app, { userKey: 'alice' });
    expect(res.json().sandbox.policy.archiveAfterSeconds).toBe(
      ARCHIVE_DEFAULT_SECONDS,
    );
  });

  it('answers 503 for an archived sandbox on a daemon without S3', async () => {
    // The operator archived with S3 configured, then rebooted without it:
    // the rows are honest, the restore is impossible, the error names it.
    const executor = new FakeExecutor();
    const { app, db } = testApp(executor);
    const created = (await acquire(app, { userKey: 'alice' })).json();
    const id = created.sandbox.sandboxId;
    transition(db, id, 'frozen');
    transition(db, id, 'stopped');
    transition(db, id, 'archived');
    await executor.destroy(id);

    const res = await acquire(app, { userKey: 'alice' });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/no S3 configured \(DORMICE_S3_\*\)/);
  });

  it('release of an archived sandbox deletes the S3 object and the row', async () => {
    const { app, db, executor, locks, store, archiver } = archiverTestApp();
    const created = (
      await acquire(app, {
        userKey: 'alice',
        policy: {
          freezeAfterSeconds: 1,
          stopAfterSeconds: 2,
          archiveAfterSeconds: 3,
        },
      })
    ).json();
    const id = created.sandbox.sandboxId;
    const stamp = created.sandbox.lastActiveAt;
    await scanOnce(db, executor, locks, after(stamp, 1), archiver);
    await scanOnce(db, executor, locks, after(stamp, 2), archiver);
    await scanOnce(db, executor, locks, after(stamp, 3), archiver);
    expect(store.has(objectKey(id))).toBe(true);

    const res = await rpc(app, '/releaseSandbox', { userKey: 'alice' });
    expect(res.json()).toEqual({ released: true });
    expect(store.has(objectKey(id))).toBe(false);
    expect((await rpc(app, '/listSandboxes')).json().sandboxes).toEqual([]);
  });

  it('answers 409 for a release while the restore runs', async () => {
    const { app, db, executor, locks, store, archiver } = archiverTestApp();
    const created = (
      await acquire(app, {
        userKey: 'alice',
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

    const restoring = (await acquire(app, { userKey: 'alice' })).json();
    expect(restoring.status).toBe('restoring');
    const res = await rpc(app, '/releaseSandbox', { userKey: 'alice' });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/restoring; retry/);

    releaseDownload();
    await acquireUntilReady(app, 'alice');
  });

  it('answers 409 for exec and file verbs on an archived sandbox', async () => {
    const { app, db, executor, locks, archiver } = archiverTestApp();
    const created = (
      await acquire(app, {
        userKey: 'alice',
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
      userKey: 'alice',
      command: 'echo hi',
    });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().message).toMatch(/call acquireSandbox and poll/);
    const read = await rpc(app, '/readFile', {
      userKey: 'alice',
      path: 'kept.txt',
    });
    expect(read.statusCode).toBe(409);
  });
});

describe('templates', () => {
  it('registers, lists and requires auth like every native verb', async () => {
    const { app } = testApp();
    const anon = await app.inject({
      method: 'POST',
      url: '/registerTemplate',
      payload: { name: 'py', image: 'img-a' },
    });
    expect(anon.statusCode).toBe(401);

    const res = await rpc(app, '/registerTemplate', {
      name: 'py',
      image: 'img-a',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().template).toMatchObject({ name: 'py', image: 'img-a' });

    const listed = await rpc(app, '/listTemplates');
    expect(listed.json().templates).toMatchObject([
      { name: 'py', image: 'img-a' },
    ]);
  });

  it('re-registering re-points the name and keeps its birth date — the upgrade verb', async () => {
    const { app } = testApp();
    const first = (
      await rpc(app, '/registerTemplate', { name: 'py', image: 'img-a' })
    ).json().template;
    const second = (
      await rpc(app, '/registerTemplate', { name: 'py', image: 'img-b' })
    ).json().template;
    expect(second.image).toBe('img-b');
    expect(second.createdAt).toBe(first.createdAt);
    expect((await rpc(app, '/listTemplates')).json().templates).toHaveLength(1);
  });

  it("rejects a malformed name, and 'base' as reserved", async () => {
    const { app } = testApp();
    const bad = await rpc(app, '/registerTemplate', {
      name: '-bad',
      image: 'img',
    });
    expect(bad.statusCode).toBe(400);
    const base = await rpc(app, '/registerTemplate', {
      name: 'base',
      image: 'img',
    });
    expect(base.statusCode).toBe(400);
    expect(base.json().message).toMatch(/'base' is reserved/);
  });

  it('acquire with a template creates the sandbox from its image and records the name', async () => {
    const { app, executor } = testApp();
    await rpc(app, '/registerTemplate', { name: 'py', image: 'img-a' });
    const res = await acquire(app, { userKey: 'alice', template: 'py' });
    expect(res.statusCode).toBe(200);
    const sandbox = res.json().sandbox;
    expect(sandbox.template).toBe('py');
    // The physical half: the shell was actually born from the template's image.
    expect(executor.imageOf(sandbox.sandboxId)).toBe('img-a');
    // A template-less acquire stays on the base image, template null.
    const plain = (await acquire(app, { userKey: 'bob' })).json().sandbox;
    expect(plain.template).toBeNull();
  });

  it('rejects an unknown template with 400, on the wake path too', async () => {
    const { app } = testApp();
    const res = await acquire(app, { userKey: 'alice', template: 'ghost' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe(
      "unknown template 'ghost' — register it first",
    );
    // Same answer when the key already has a sandbox: the caller's mistake
    // deserves a 400 even when the value would not apply.
    await acquire(app, { userKey: 'bob' });
    const wake = await acquire(app, { userKey: 'bob', template: 'ghost' });
    expect(wake.statusCode).toBe(400);
  });

  it('a valid template on an existing key is not applied — creation-time only', async () => {
    const { app } = testApp();
    await rpc(app, '/registerTemplate', { name: 'py', image: 'img-a' });
    const created = (await acquire(app, { userKey: 'alice' })).json().sandbox;
    expect(created.template).toBeNull();
    const again = (
      await acquire(app, { userKey: 'alice', template: 'py' })
    ).json().sandbox;
    expect(again.sandboxId).toBe(created.sandboxId);
    expect(again.template).toBeNull();
  });

  it('refuses to remove a template while sandboxes use it, naming the keys', async () => {
    const { app } = testApp();
    await rpc(app, '/registerTemplate', { name: 'py', image: 'img-a' });
    await acquire(app, { userKey: 'alice', template: 'py' });

    const refused = await rpc(app, '/removeTemplate', { name: 'py' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toBe(
      "template 'py' is used by 1 sandbox(es): alice — release them first",
    );

    await rpc(app, '/releaseSandbox', { userKey: 'alice' });
    expect((await rpc(app, '/removeTemplate', { name: 'py' })).json()).toEqual({
      removed: true,
    });
    // Idempotent on an unknown name, like releaseSandbox.
    expect((await rpc(app, '/removeTemplate', { name: 'py' })).json()).toEqual({
      removed: false,
    });
  });

  it('re-point then rebuild moves the sandbox onto the new image — the upgrade front door', async () => {
    const { app, executor } = testApp();
    await rpc(app, '/registerTemplate', { name: 'py', image: 'img-v1' });
    const created = (
      await acquire(app, { userKey: 'alice', template: 'py' })
    ).json().sandbox;
    expect(executor.imageOf(created.sandboxId)).toBe('img-v1');

    // Operator builds a new image and re-points the name; the stock moves
    // per sandbox, on its own rebuild — never behind its back.
    await rpc(app, '/registerTemplate', { name: 'py', image: 'img-v2' });
    expect(executor.imageOf(created.sandboxId)).toBe('img-v1');

    await rpc(app, '/rebuildSandbox', { userKey: 'alice' });
    const woken = (await acquire(app, { userKey: 'alice' })).json().sandbox;
    expect(woken.sandboxId).toBe(created.sandboxId);
    // The rebuilt shell was born from the template's *current* image.
    expect(executor.imageOf(created.sandboxId)).toBe('img-v2');
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
    const { app } = testApp(new FakeExecutor(), {
      DORMICE_DATA_DIR: tmpdir(),
    });
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
      maxSandboxes: 100,
      byState: { active: 0, frozen: 0, stopped: 0, archived: 0, restoring: 0 },
    });
    expect(body.sandboxDisks).toEqual({
      count: 0,
      nominalBytes: 0,
      actualBytes: 0,
    });
  });

  it('reports a missing data dir as null — absent, not invented', async () => {
    const { app } = testApp(new FakeExecutor(), {
      DORMICE_DATA_DIR: '/no/such/dormice-data',
    });
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
        userKey: 'alice',
        policy: { freezeAfterSeconds: 60 },
      })
    ).json();
    await acquire(app, { userKey: 'bob' });

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
    expect(executor.stateOf(created.sandbox.sandboxId)).toBe('paused');
  });
});
