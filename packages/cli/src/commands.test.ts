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
  apikeyCreate,
  apikeyDisable,
  apikeyEnable,
  apikeyLs,
  apikeyRevoke,
  clientFromEnv,
  parseLabels,
  pullSavedMessage,
  sandboxDestroy,
  sandboxExec,
  sandboxLs,
  sandboxMeta,
  sandboxPull,
  sandboxPush,
  sandboxRebuild,
  templateAdd,
  templateLs,
  templateRm,
} from './commands';

const TOKEN = 'test-token-test-token-test-token';
// Tests live inside the monorepo, so the server's migrations are reachable
// as a sibling package. Not part of the published CLI.
const MIGRATIONS = fileURLToPath(
  new URL('../../server/drizzle', import.meta.url),
);

let app: ReturnType<typeof buildApp>;
let client: Dormice;
let endpoint: string;

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
  endpoint = `http://127.0.0.1:${address.port}`;
  client = new Dormice({ endpoint, token: TOKEN });
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
    const alice = await client.acquireSandbox('alice', {
      metadata: { app: 'demo' },
    });
    await client.acquireSandbox('bob');

    const output = await sandboxLs(client);
    const lines = output.split('\n');
    expect(lines[0]).toMatch(
      /^NAME\s{2,}STATE\s{2,}ID\s{2,}LAST ACTIVE\s{2,}METADATA$/,
    );
    expect(output).toMatch(/alice\s{2,}active/);
    expect(output).toMatch(/bob\s{2,}active/);
    expect(output).toContain(alice.sandbox.id);
    expect(output).toContain('app=demo');
  });

  it('meta shows, replaces and clears the label set', async () => {
    await client.acquireSandbox('labeled', {
      metadata: { app: 'demo', env: 'prod' },
    });
    expect(await sandboxMeta(client, 'labeled', null)).toBe(
      'app=demo,env=prod',
    );
    expect(await sandboxMeta(client, 'labeled', { app: 'ci' })).toBe(
      'Metadata of "labeled" is now app=ci.',
    );
    expect(await sandboxMeta(client, 'labeled', {})).toBe(
      'Cleared metadata of "labeled".',
    );
    expect(await sandboxMeta(client, 'labeled', null)).toBe('No metadata.');
    await expect(sandboxMeta(client, 'nobody', null)).rejects.toThrow(
      /acquire it first/,
    );
    await client.destroySandbox('labeled');
  });

  it('neutralizes control characters a hostile name smuggles in', async () => {
    // The protocol keeps name opaque, so an ESC sequence is a legal key;
    // printed raw it would rewrite the operator's terminal.
    await client.acquireSandbox('evil\u001b[31mkey');
    const output = await sandboxLs(client);
    expect(output).not.toContain('\u001b');
    expect(output).toContain('evil?[31mkey');
    await client.destroySandbox('evil\u001b[31mkey');
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
    await client.destroySandbox('dave');
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
    await client.destroySandbox('pusher');
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
    await client.destroySandbox('puller');
  });

  it('rebuild reports the swap and surfaces the 404 for an unknown key', async () => {
    await client.acquireSandbox('rebuilder');
    expect(await sandboxRebuild(client, 'rebuilder')).toBe(
      'Rebuilt the sandbox "rebuilder" — /home/user kept, now stopped; ' +
        'its next use starts on the current base image.',
    );
    await expect(sandboxRebuild(client, 'nobody')).rejects.toThrow(
      /acquire it first/,
    );
    await client.destroySandbox('rebuilder');
  });

  it('destroy reports both outcomes of the idempotent destroy', async () => {
    await client.acquireSandbox('carol');
    expect(await sandboxDestroy(client, 'carol')).toBe(
      'Destroyed the sandbox "carol".',
    );
    expect(await sandboxDestroy(client, 'carol')).toBe(
      'No sandbox named "carol" — nothing to destroy.',
    );
  });
});

describe('parseLabels', () => {
  it('splits on the first = only — values keep their own', () => {
    expect(parseLabels(['app=crawler', 'note=a=b'])).toEqual({
      app: 'crawler',
      note: 'a=b',
    });
  });

  it('names the offending word when it is not key=value', () => {
    expect(() => parseLabels(['nope'])).toThrow(/"nope" is not key=value/);
    expect(() => parseLabels(['=value'])).toThrow(/not key=value/);
  });
});

describe('apikey commands over real HTTP', () => {
  it('create, ls and revoke walk the rotation life end to end', async () => {
    expect(await apikeyLs(client)).toBe('No API keys.');

    const created = await apikeyCreate(client, 'ci');
    const lines = created.split('\n');
    expect(lines[0]).toMatch(/^Created API key "ci" \(prefix [0-9a-f]{8}\)\.$/);
    expect(lines[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(lines[2]).toBe('Store it now — it will never be shown again.');

    const output = await apikeyLs(client);
    expect(output.split('\n')[0]).toMatch(
      /^NAME\s{2,}PREFIX\s{2,}CREATED\s{2,}LAST USED\s{2,}EXPIRES\s{2,}STATUS$/,
    );
    expect(output).toMatch(/ci\s{2,}[0-9a-f]{8}.*never\s{2,}never\s{2,}active/);

    expect(await apikeyRevoke(client, 'ci')).toBe(
      'Revoked API key "ci" — it stops working immediately.',
    );
    expect(await apikeyRevoke(client, 'ci')).toBe(
      'No active API key named "ci" — nothing to revoke.',
    );
    expect(await apikeyLs(client)).toMatch(/ci\s{2,}.*revoked/);
  });

  it('disable parks a key by name; enable resumes it; a disabled key still revokes by name', async () => {
    await apikeyCreate(client, 'park-me');

    expect(await apikeyDisable(client, 'park-me')).toBe(
      'Disabled API key "park-me" — it stops working until re-enabled.',
    );
    expect(await apikeyLs(client)).toMatch(/park-me\s{2,}.*disabled/);

    expect(await apikeyEnable(client, 'park-me')).toBe(
      'Enabled API key "park-me".',
    );
    expect(await apikeyLs(client)).toMatch(/park-me\s{2,}.*active/);

    // Disabled keys keep their name — revoke must still reach them by it.
    await apikeyDisable(client, 'park-me');
    expect(await apikeyRevoke(client, 'park-me')).toBe(
      'Revoked API key "park-me" — it stops working immediately.',
    );
    await expect(apikeyDisable(client, 'park-me')).rejects.toThrow(
      /no API key named "park-me"/,
    );
  });

  it('--expires mints a TTL key through end-of-day and refuses garbage dates', async () => {
    const created = await apikeyCreate(client, 'ttl', '2030-06-15');
    expect(created.split('\n')[0]).toMatch(
      /^Created API key "ttl" \(prefix [0-9a-f]{8}, expires 2030-06-1[56]T.*\)\.$/,
    );
    expect(await apikeyLs(client)).toMatch(/ttl\s{2,}.*active/);

    await expect(apikeyCreate(client, 'bad', 'next tuesday')).rejects.toThrow(
      /--expires must be a date like 2026-12-31/,
    );
    await expect(apikeyCreate(client, 'bad', '2030-02-31')).rejects.toThrow(
      /--expires/,
    );
  });

  it("a minted key is refused on the management verbs with the server's honest 403", async () => {
    const created = await apikeyCreate(client, 'not-admin');
    const token = created.split('\n')[1] ?? '';
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const keyed = new Dormice({ endpoint, token });
    await expect(apikeyLs(keyed)).rejects.toThrow(
      /cannot manage API keys — use DORMICE_API_TOKEN or the console/,
    );
  });
});

describe('template commands over real HTTP', () => {
  it('add, ls and rm walk the registration life end to end', async () => {
    expect(await templateLs(client)).toBe('No templates.');

    expect(await templateAdd(client, 'py311', 'img:py311')).toBe(
      'Registered template "py311" -> img:py311.',
    );
    const output = await templateLs(client);
    expect(output.split('\n')[0]).toMatch(
      /^NAME\s{2,}IMAGE\s{2,}CREATED\s{2,}UPDATED$/,
    );
    expect(output).toMatch(/py311\s{2,}img:py311/);

    expect(await templateRm(client, 'py311')).toBe('Removed template "py311".');
    expect(await templateRm(client, 'py311')).toBe(
      'No template named "py311" — nothing to remove.',
    );
  });
});
