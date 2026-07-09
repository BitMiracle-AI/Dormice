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
      freezeAfterSeconds: 60,
      archiveAfterSeconds: null,
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
      client.acquireSandbox('carol', { archiveAfterSeconds: 1 }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/stopAfterSeconds/),
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
    const erin = sandboxes.find((s) => s.userKey === 'erin');
    expect(erin?.state).toBe('active');
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
          body: JSON.stringify({ userKey: 'henry', command: 'sleep 1' }),
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

  it('releases a sandbox and reports idempotently', async () => {
    const created = await client.acquireSandbox('frank');
    expect(await client.releaseSandbox('frank')).toEqual({ released: true });
    expect(executor.stateOf(created.sandbox.sandboxId)).toBeUndefined();
    expect(await client.releaseSandbox('frank')).toEqual({ released: false });

    const again = await client.acquireSandbox('frank');
    expect(again.sandbox.sandboxId).not.toBe(created.sandbox.sandboxId);
  });
});
