import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { migrateDb, openDb } from '../db/db';
import { FakeExecutor } from '../executor/fake';
import { KeyedQueue } from '../keyed-queue';
import { configureNode } from '../testing';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const TOKEN = 'test-token-test-token-test-token';

function testApp() {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const config = loadConfig({
    DORMICE_DB_PATH: ':memory:',
    DORMICE_API_TOKEN: TOKEN,
  });
  configureNode(db);
  return buildApp({
    config,
    db,
    executor: new FakeExecutor(),
    locks: new KeyedQueue(),
    logger: false,
  });
}

describe('POST /envdToken', () => {
  it('the fleet token mints the exact token the envd surface accepts, per sandbox', async () => {
    const app = testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/envdToken',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { sandboxId: 'sb-terminal' },
    });
    expect(res.statusCode).toBe(200);
    const { envdAccessToken } = res.json() as { envdAccessToken: string };
    // The envd surface itself is the judge — the token derives from the
    // ledger's signing secret, which nothing outside the daemon (this test
    // included) can recompute. Auth passing shows as anything-but-401.
    const probe = (sandboxId: string) =>
      app.inject({
        method: 'POST',
        url: '/e2b/envd/filesystem.Filesystem/Stat',
        headers: {
          'e2b-sandbox-id': sandboxId,
          'x-access-token': envdAccessToken,
        },
        payload: { path: '/home/user' },
      });
    expect((await probe('sb-terminal')).statusCode).not.toBe(401);
    // Per-sandbox: the same token opens no other sandbox.
    expect((await probe('sb-other')).statusCode).toBe(401);
  });

  it('sits behind the API-wide arbiter: no token, no mint — and the console session is not a credential here', async () => {
    const app = testApp();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/envdToken',
          payload: { sandboxId: 'sb-terminal' },
        })
      ).statusCode,
    ).toBe(401);
    // A cookie is the gateway's business; on a node it opens nothing.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/envdToken',
          headers: { 'x-dormice-console': '1' },
          cookies: { dormice_session: '99999999999.deadbeef' },
          payload: { sandboxId: 'sb-terminal' },
        })
      ).statusCode,
    ).toBe(401);
  });
});
