import { fileURLToPath } from 'node:url';
import { Dormice } from '@dormice/sdk';
import {
  buildApp,
  FakeExecutor,
  KeyedQueue,
  loadConfig,
  migrateDb,
  openDb,
} from '@dormice/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clientFromEnv,
  pullSavedMessage,
  sandboxExec,
  sandboxLs,
  sandboxPull,
  sandboxPush,
  sandboxRebuild,
  sandboxRelease,
} from './commands';

const TOKEN = 'test-token-test-token-test-token';
// Tests live inside the monorepo, so the server's migrations are reachable
// as a sibling package. Not part of the published CLI.
const MIGRATIONS = fileURLToPath(
  new URL('../../server/drizzle', import.meta.url),
);

let app: ReturnType<typeof buildApp>;
let client: Dormice;

beforeAll(async () => {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  // Through loadConfig on purpose: defaults are adjudicated once, in the
  // schema — a hand-written literal here would drift as knobs are added.
  const config = loadConfig({
    DORMICE_DB_PATH: ':memory:',
    DORMICE_NODE_ID: 'node-test',
    DORMICE_API_TOKEN: TOKEN,
  });
  app = buildApp({
    config,
    db,
    executor: new FakeExecutor(),
    locks: new KeyedQueue(),
    logger: false,
  });
  // Port 0: the OS hands out a free ephemeral port, so tests never collide
  // with a locally running daemon.
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('expected a TCP address');
  }
  client = new Dormice({
    endpoint: `http://127.0.0.1:${address.port}`,
    token: TOKEN,
  });
});

afterAll(async () => {
  await app.close();
});

describe('clientFromEnv', () => {
  it('names every missing variable', () => {
    expect(() => clientFromEnv({})).toThrow(
      /DORMICE_ENDPOINT and DORMICE_API_TOKEN/,
    );
  });

  it('names only the variable that is actually missing', () => {
    expect(() =>
      clientFromEnv({ DORMICE_ENDPOINT: 'http://127.0.0.1:3676' }),
    ).toThrow(/^DORMICE_API_TOKEN must be set/);
  });

  it('builds a client when both variables are set', () => {
    const built = clientFromEnv({
      DORMICE_ENDPOINT: 'http://127.0.0.1:3676',
      DORMICE_API_TOKEN: TOKEN,
    });
    expect(built).toBeInstanceOf(Dormice);
  });
});

describe('sandbox commands over real HTTP', () => {
  // Runs first: the daemon starts with an empty ledger.
  it('ls reports an empty daemon honestly', async () => {
    expect(await sandboxLs(client)).toBe('No sandboxes.');
  });

  it('ls renders one aligned row per sandbox', async () => {
    const alice = await client.acquireSandbox('alice');
    await client.acquireSandbox('bob');

    const output = await sandboxLs(client);
    const lines = output.split('\n');
    expect(lines[0]).toMatch(
      /^USER KEY\s{2,}STATE\s{2,}SANDBOX ID\s{2,}LAST ACTIVE$/,
    );
    expect(output).toMatch(/alice\s{2,}active/);
    expect(output).toMatch(/bob\s{2,}active/);
    expect(output).toContain(alice.sandbox.sandboxId);
  });

  it('neutralizes control characters a hostile user key smuggles in', async () => {
    // The protocol keeps userKey opaque, so an ESC sequence is a legal key;
    // printed raw it would rewrite the operator's terminal.
    await client.acquireSandbox('evil\u001b[31mkey');
    const output = await sandboxLs(client);
    expect(output).not.toContain('\u001b');
    expect(output).toContain('evil?[31mkey');
    await client.releaseSandbox('evil\u001b[31mkey');
  });

  it('exec hands back the three channels untouched', async () => {
    await client.acquireSandbox('dave');
    expect(await sandboxExec(client, 'dave', 'echo hi')).toEqual({
      stdout: 'hi\n',
      stderr: '',
      exitCode: 0,
    });
    // The exit code passes through as data; main.ts turns it into the
    // process's own.
    expect((await sandboxExec(client, 'dave', 'exit 3')).exitCode).toBe(3);
    await client.releaseSandbox('dave');
  });

  it('push reports the resolved path and byte count', async () => {
    await client.acquireSandbox('pusher');
    const message = await sandboxPush(
      client,
      'pusher',
      new TextEncoder().encode('hi'),
      'notes.txt',
    );
    expect(message).toBe('Wrote /home/user/notes.txt (2 bytes).');
    await client.releaseSandbox('pusher');
  });

  it('pull hands back the exact bytes; the save message is separate', async () => {
    await client.acquireSandbox('puller');
    const bytes = new Uint8Array([0, 1, 254, 255]);
    await client.writeFiles('puller', [{ path: 'data.bin', content: bytes }]);

    const result = await sandboxPull(client, 'puller', 'data.bin');
    expect(result.path).toBe('/home/user/data.bin');
    expect(result.content).toEqual(bytes);
    expect(pullSavedMessage(result, 'local.bin')).toBe(
      'Pulled /home/user/data.bin -> local.bin (4 bytes).',
    );
    await client.releaseSandbox('puller');
  });

  it('rebuild reports the swap and surfaces the 404 for an unknown key', async () => {
    await client.acquireSandbox('rebuilder');
    expect(await sandboxRebuild(client, 'rebuilder')).toBe(
      'Rebuilt the sandbox for key "rebuilder" — /home/user kept, now stopped; ' +
        'its next use starts on the current base image.',
    );
    await expect(sandboxRebuild(client, 'nobody')).rejects.toThrow(
      /acquire it first/,
    );
    await client.releaseSandbox('rebuilder');
  });

  it('release reports both outcomes of the idempotent destroy', async () => {
    await client.acquireSandbox('carol');
    expect(await sandboxRelease(client, 'carol')).toBe(
      'Released the sandbox for key "carol".',
    );
    expect(await sandboxRelease(client, 'carol')).toBe(
      'No sandbox for key "carol" — nothing to release.',
    );
  });
});
