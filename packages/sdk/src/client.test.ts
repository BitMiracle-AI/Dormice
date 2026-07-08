import { buildApp, type Config, migrateDb, openDb } from '@dormice/server';
import { DEFAULT_LIFECYCLE_POLICY } from '@dormice/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dormice } from './client';

const TOKEN = 'test-token-test-token-test-token';
// Tests live inside the monorepo, so the server's migrations are reachable
// as a sibling package. Not part of the published SDK.
const MIGRATIONS = new URL('../../server/drizzle', import.meta.url).pathname;

let app: ReturnType<typeof buildApp>;
let client: Dormice;
let endpoint: string;

beforeAll(async () => {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const config: Config = {
    DORMICE_PORT: 3676,
    DORMICE_DB_PATH: ':memory:',
    DORMICE_NODE_ID: 'node-test',
    DORMICE_API_TOKEN: TOKEN,
  };
  app = buildApp({ config, db, logger: false });
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
});
