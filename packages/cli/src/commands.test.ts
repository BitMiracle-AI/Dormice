import { Dormice } from '@dormice/sdk';
import {
  buildApp,
  FakeExecutor,
  loadConfig,
  migrateDb,
  openDb,
} from '@dormice/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientFromEnv, sandboxLs, sandboxRelease } from './commands';

const TOKEN = 'test-token-test-token-test-token';
// Tests live inside the monorepo, so the server's migrations are reachable
// as a sibling package. Not part of the published CLI.
const MIGRATIONS = new URL('../../server/drizzle', import.meta.url).pathname;

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
  app = buildApp({ config, db, executor: new FakeExecutor(), logger: false });
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
