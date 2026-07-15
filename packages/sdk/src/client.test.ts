import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  buildApp,
  type Db,
  FakeExecutor,
  KeyedQueue,
  loadConfig,
  migrateDb,
  openDb,
  scanOnce,
} from '@dormice/server';
import { DEFAULT_LIFECYCLE_POLICY } from '@dormice/shared';
import {
  Agent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  fetch as undiciFetch,
} from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dormice } from './client';

const TOKEN = 'test-token-test-token-test-token';
// Tests live inside the monorepo, so the server's migrations are reachable
// as a sibling package. Not part of the published SDK.
const MIGRATIONS = fileURLToPath(
  new URL('../../server/drizzle', import.meta.url),
);

let app: ReturnType<typeof buildApp>;
let client: Dormice;
let endpoint: string;
let db: Db;
let executor: FakeExecutor;
let locks: KeyedQueue;

beforeAll(async () => {
  db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  executor = new FakeExecutor();
  locks = new KeyedQueue();
  // Through loadConfig on purpose: defaults are adjudicated once, in the
  // schema — a hand-written literal here would drift as knobs are added.
  const config = loadConfig({
    DORMICE_DB_PATH: ':memory:',
    DORMICE_NODE_ID: 'node-test',
    DORMICE_API_TOKEN: TOKEN,
  });
  app = buildApp({ config, db, executor, locks, logger: false });
  // Port 0: the OS hands out a free ephemeral port, so tests never collide
  // with a locally running daemon.
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('expected a TCP address');
  }
  endpoint = `http://127.0.0.1:${address.port}`;
  client = new Dormice({ endpoint, token: TOKEN });
});

afterAll(async () => {
  await app.close();
});

describe('Dormice.acquireSandbox over real HTTP', () => {
  it('acquires a sandbox with the default policy', async () => {
    const res = await client.acquireSandbox('alice');
    expect(res.status).toBe('ready');
    expect(res.sandbox.state).toBe('active');
    expect(res.sandbox.policy).toEqual(DEFAULT_LIFECYCLE_POLICY);
  });

  it('is idempotent: the same key returns the same sandbox', async () => {
    const first = await client.acquireSandbox('alice');
    const second = await client.acquireSandbox('alice');
    expect(second.sandbox.sandboxId).toBe(first.sandbox.sandboxId);
  });

  it('passes a policy override through', async () => {
    const res = await client.acquireSandbox('bob', {
      policy: { freezeAfterSeconds: 60, archiveAfterSeconds: null },
    });
    expect(res.sandbox.policy).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      freezeAfterSeconds: 60,
      archiveAfterSeconds: null,
    });
  });

  it('throws DormiceApiError with status 401 on a wrong token', async () => {
    const bad = new Dormice({ endpoint, token: 'w'.repeat(32) });
    await expect(bad.acquireSandbox('alice')).rejects.toMatchObject({
      name: 'DormiceApiError',
      status: 401,
    });
  });

  it("surfaces the server's message for an invalid policy", async () => {
    await expect(
      client.acquireSandbox('carol', {
        policy: { freezeAfterSeconds: 61, stopAfterSeconds: 60 },
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/freezeAfterSeconds/),
    });
  });

  it("surfaces the server's refusal of archiving without S3", async () => {
    // This test server has no archiver; the union's `restoring` arm is
    // exercised end-to-end by the e2e archive suite instead.
    await expect(
      client.acquireSandbox('carol', { policy: { archiveAfterSeconds: 1 } }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/archiving requires S3/),
    });
  });

  it('tolerates a trailing slash in the endpoint', async () => {
    const slashed = new Dormice({ endpoint: `${endpoint}/`, token: TOKEN });
    const res = await slashed.acquireSandbox('alice');
    expect(res.status).toBe('ready');
  });

  it('times out instead of hanging forever on a wedged daemon', async () => {
    // A server that accepts the connection and then never answers.
    const wedged = createServer(() => {});
    await new Promise<void>((resolve) =>
      wedged.listen(0, '127.0.0.1', resolve),
    );
    const address = wedged.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('expected a TCP address');
    }
    try {
      const impatient = new Dormice({
        endpoint: `http://127.0.0.1:${address.port}`,
        token: TOKEN,
        timeoutMs: 100,
      });
      await expect(impatient.acquireSandbox('alice')).rejects.toMatchObject({
        name: 'TimeoutError',
      });
    } finally {
      wedged.close();
    }
  });

  it('wakes a frozen sandbox on re-acquire — the full story over the wire', async () => {
    const created = await client.acquireSandbox('dave');
    const frozenAt = new Date(
      Date.parse(created.sandbox.lastActiveAt) +
        DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds * 1000,
    );
    await scanOnce(db, executor, locks, frozenAt);
    expect(executor.stateOf(created.sandbox.sandboxId)).toBe('paused');

    const woken = await client.acquireSandbox('dave');
    expect(woken.status).toBe('ready');
    expect(woken.sandbox.sandboxId).toBe(created.sandbox.sandboxId);
    expect(woken.sandbox.state).toBe('active');
    expect(executor.stateOf(created.sandbox.sandboxId)).toBe('running');
  });

  it('lists sandboxes with their lifecycle states', async () => {
    await client.acquireSandbox('erin');
    const sandboxes = await client.listSandboxes();
    const erin = sandboxes.find((s) => s.externalId === 'erin');
    expect(erin?.state).toBe('active');
  });

  it('reads host metrics: real host numbers, ledger aggregates in step', async () => {
    await client.acquireSandbox('metrics-watcher');
    const metrics = await client.getHostMetrics();
    expect(metrics.host.cpuCount).toBeGreaterThan(0);
    expect(metrics.host.memTotalBytes).toBeGreaterThan(0);
    const listed = await client.listSandboxes();
    expect(metrics.sandboxes.total).toBe(listed.length);
    expect(metrics.sandboxDisks.count).toBeGreaterThanOrEqual(1);
    expect(metrics.sandboxDisks.nominalBytes).toBeGreaterThan(
      metrics.sandboxDisks.actualBytes,
    );
  });

  it('runs a command in the sandbox and returns the buffered result', async () => {
    await client.acquireSandbox('grace');
    const result = await client.execCommand('grace', 'echo hi');
    expect(result).toEqual({
      exitCode: 0,
      stdout: 'hi\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    // A nonzero exit is a result, not a throw.
    expect((await client.execCommand('grace', 'exit 3')).exitCode).toBe(3);
  });

  it("outlives a default dispatcher's headers clock on a long exec", async () => {
    // An exec response starts only when the command ends, so a long command
    // starves any clock that watches for response headers — undici's default
    // gives up at 300s (measured on the real daemon: `fetch failed` at
    // exactly five minutes). 300s is untestable here, so pinch the global
    // dispatcher's clock down to 250ms and race it against `sleep 1`.
    const prior = getGlobalDispatcher();
    setGlobalDispatcher(new Agent({ headersTimeout: 250 }));
    try {
      await client.acquireSandbox('henry');
      // Reverse verification: a fetch that does NOT bring its own
      // dispatcher dies on the pinched clock — the threat is real.
      await expect(
        undiciFetch(`${endpoint}/execCommand`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ externalId: 'henry', command: 'sleep 1' }),
        }),
      ).rejects.toThrow(/fetch failed/);
      // The SDK carries its own dispatcher, so the same call sails through.
      const result = await client.execCommand('henry', 'sleep 1');
      expect(result.exitCode).toBe(0);
    } finally {
      setGlobalDispatcher(prior);
    }
  });

  it('surfaces the 404 for an exec against an unknown key', async () => {
    await expect(client.execCommand('nobody', 'echo hi')).rejects.toMatchObject(
      {
        name: 'DormiceApiError',
        status: 404,
        message: expect.stringMatching(/no sandbox for key/),
      },
    );
  });

  it('writes files — string and bytes — and reads them back exact', async () => {
    await client.acquireSandbox('files-key');
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;

    const written = await client.writeFiles('files-key', [
      // Multi-byte text: proves strings go through as UTF-8, not mangled.
      { path: 'notes.txt', content: 'hello 文件\n' },
      { path: '/home/user/blob.bin', content: bytes },
    ]);
    expect(written.files).toEqual([
      { path: '/home/user/notes.txt' },
      { path: '/home/user/blob.bin' },
    ]);

    const text = await client.readFile('files-key', 'notes.txt');
    expect(text.path).toBe('/home/user/notes.txt');
    expect(new TextDecoder().decode(text.content)).toBe('hello 文件\n');

    const blob = await client.readFile('files-key', 'blob.bin');
    expect(blob.content).toEqual(bytes);
  });

  it('surfaces the 404 for a missing file', async () => {
    await client.acquireSandbox('files-key');
    await expect(
      client.readFile('files-key', 'no-such.txt'),
    ).rejects.toMatchObject({
      name: 'DormiceApiError',
      status: 404,
      message: 'no such file: /home/user/no-such.txt',
    });
  });

  it('rebuilds a sandbox: same id, state stopped, data intact after re-acquire', async () => {
    const created = await client.acquireSandbox('grace');
    const id = created.sandbox.sandboxId;
    await client.writeFiles('grace', [{ path: 'keep.txt', content: 'body' }]);

    const { sandbox } = await client.rebuildSandbox('grace');
    expect(sandbox.sandboxId).toBe(id);
    expect(sandbox.state).toBe('stopped');
    expect(executor.stateOf(id)).toBeUndefined();

    const again = await client.acquireSandbox('grace');
    expect(again.sandbox.sandboxId).toBe(id);
    const read = await client.readFile('grace', 'keep.txt');
    expect(new TextDecoder().decode(read.content)).toBe('body');

    await expect(client.rebuildSandbox('no-such-key')).rejects.toMatchObject({
      name: 'DormiceApiError',
      status: 404,
    });
  });

  it('patches a lifecycle policy in place, keeping the untouched knobs', async () => {
    const created = await client.acquireSandbox('policy-key');
    const { sandbox } = await client.updatePolicy('policy-key', {
      stopAfterSeconds: null,
    });
    expect(sandbox.sandboxId).toBe(created.sandbox.sandboxId);
    expect(sandbox.policy).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      stopAfterSeconds: null,
    });

    await expect(
      client.updatePolicy('no-such-key', { freezeAfterSeconds: 60 }),
    ).rejects.toMatchObject({ name: 'DormiceApiError', status: 404 });
    await expect(
      // Merged with the stored policy this breaks the ordering rule.
      client.updatePolicy('policy-key', { archiveAfterSeconds: 1 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('releases a sandbox and reports idempotently', async () => {
    const created = await client.acquireSandbox('frank');
    expect(await client.destroySandbox('frank')).toEqual({ destroyed: true });
    expect(executor.stateOf(created.sandbox.sandboxId)).toBeUndefined();
    expect(await client.destroySandbox('frank')).toEqual({ destroyed: false });

    const again = await client.acquireSandbox('frank');
    expect(again.sandbox.sandboxId).not.toBe(created.sandbox.sandboxId);
  });
});

describe('templates over real HTTP', () => {
  it('registers, lists, applies at acquire, and removes through the full life', async () => {
    await client.registerTemplate('tpl-sdk', 'img-sdk');
    expect(await client.listTemplates()).toMatchObject([
      { name: 'tpl-sdk', image: 'img-sdk' },
    ]);

    const res = await client.acquireSandbox('tpl-user', {
      template: 'tpl-sdk',
    });
    expect(res.sandbox.template).toBe('tpl-sdk');
    expect(await executor.imageOf(res.sandbox.sandboxId)).toBe('img-sdk');

    // In use: removal is refused, naming the key that holds it.
    await expect(client.removeTemplate('tpl-sdk')).rejects.toMatchObject({
      name: 'DormiceApiError',
      status: 409,
      message: expect.stringMatching(/tpl-user/),
    });

    await client.destroySandbox('tpl-user');
    expect(await client.removeTemplate('tpl-sdk')).toEqual({ removed: true });
    expect(await client.removeTemplate('tpl-sdk')).toEqual({ removed: false });
  });

  it("surfaces the server's 400 for an unknown template", async () => {
    await expect(
      client.acquireSandbox('tpl-nobody', { template: 'ghost' }),
    ).rejects.toMatchObject({
      status: 400,
      message: "unknown template 'ghost' — register it first",
    });
  });
});

describe('API keys over real HTTP', () => {
  it('mints a key a fresh client can use, revokes it, and the door closes', async () => {
    const { apiKey, token } = await client.createApiKey('sdk-rotation');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(apiKey.prefix).toBe(token.slice(0, 8));

    // The rotation story: a new client on the minted key does real work.
    const keyed = new Dormice({ endpoint, token });
    await keyed.acquireSandbox('keyed-user');
    await keyed.destroySandbox('keyed-user');

    const listed = await client.listApiKeys();
    const mine = listed.find((k) => k.name === 'sdk-rotation');
    expect(mine?.lastUsedAt).not.toBeNull();

    expect(await client.revokeApiKey('sdk-rotation')).toEqual({
      revoked: true,
    });
    await expect(keyed.listSandboxes()).rejects.toMatchObject({ status: 401 });
    expect(await client.revokeApiKey('sdk-rotation')).toEqual({
      revoked: false,
    });
  });

  it("surfaces the server's 409 for a duplicate active name", async () => {
    await client.createApiKey('sdk-dup');
    await expect(client.createApiKey('sdk-dup')).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/sdk-dup/),
    });
    await client.revokeApiKey('sdk-dup');
  });
});

describe('the observability verbs over real HTTP', () => {
  it('getConfig reports the knobs and withholds the token', async () => {
    // Source attribution is asserted server-side with injected sources;
    // this test app reads the real process.env, which proves nothing here.
    const config = await client.getConfig();
    const token = config.entries.find((e) => e.key === 'DORMICE_API_TOKEN');
    expect(token).toMatchObject({ value: null, redacted: true });
    const port = config.entries.find((e) => e.key === 'DORMICE_PORT');
    expect(port).toMatchObject({ value: '3676' });
    expect(config.archive.enabled).toBe(false);
  });

  it('getSandboxMetrics answers a sample for a live sandbox and 404s an unknown key', async () => {
    await client.acquireSandbox('metrics-sdk');
    const sample = await client.getSandboxMetrics('metrics-sdk');
    expect(sample?.memTotalBytes).toBeGreaterThan(0);
    await client.destroySandbox('metrics-sdk');

    await expect(
      client.getSandboxMetrics('metrics-nobody'),
    ).rejects.toMatchObject({
      name: 'DormiceApiError',
      status: 404,
    });
  });

  it('listSandboxMetrics answers every measurable sandbox in one call', async () => {
    await client.acquireSandbox('fleet-a');
    await client.acquireSandbox('fleet-b');
    const samples = await client.listSandboxMetrics();
    const mine = samples.filter((s) => s.externalId.startsWith('fleet-'));
    expect(mine.map((s) => s.externalId).sort()).toEqual([
      'fleet-a',
      'fleet-b',
    ]);
    for (const entry of mine) {
      expect(entry.sample.memTotalBytes).toBeGreaterThan(0);
    }
    await client.destroySandbox('fleet-a');
    await client.destroySandbox('fleet-b');
    // Released means gone from the measurable set, not null-stuffed.
    const after = await client.listSandboxMetrics();
    expect(after.filter((s) => s.externalId.startsWith('fleet-'))).toEqual([]);
  });

  it('listActivity tells the story just written, newest first', async () => {
    await client.acquireSandbox('story-sdk');
    await client.destroySandbox('story-sdk');
    const log = await client.listActivity({ limit: 10 });
    const mine = log.filter((e) => e.externalId === 'story-sdk');
    expect(mine.map((e) => e.kind)).toEqual(['destroyed', 'created']);
  });
});
