import { DEFAULT_LIFECYCLE_POLICY } from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import type { Config } from './config';
import { migrateDb, openDb } from './db/db';

const MIGRATIONS = new URL('../drizzle', import.meta.url).pathname;
const TOKEN = 'test-token-test-token-test-token';

function testApp() {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const config: Config = {
    DORMICE_PORT: 3676,
    DORMICE_DB_PATH: ':memory:',
    DORMICE_NODE_ID: 'node-test',
    DORMICE_API_TOKEN: TOKEN,
  };
  return buildApp({ config, db, logger: false });
}

const authed = { authorization: `Bearer ${TOKEN}` };

function acquire(
  app: ReturnType<typeof testApp>,
  payload: Record<string, unknown>,
  headers: Record<string, string> = authed,
) {
  return app.inject({
    method: 'POST',
    url: '/sandboxes/acquire',
    headers,
    payload,
  });
}

describe('auth', () => {
  it('leaves /healthz open', async () => {
    const res = await testApp().inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects API calls without a token', async () => {
    const res = await acquire(testApp(), { userKey: 'u' }, {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects API calls with a wrong token', async () => {
    const res = await acquire(
      testApp(),
      { userKey: 'u' },
      { authorization: 'Bearer wrong-token-wrong-token-wrong-token' },
    );
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /sandboxes/acquire', () => {
  it('creates a sandbox on first acquire, with default policy', async () => {
    const res = await acquire(testApp(), { userKey: 'alice' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.sandbox.state).toBe('active');
    expect(body.sandbox.userKey).toBe('alice');
    expect(body.sandbox.policy).toEqual(DEFAULT_LIFECYCLE_POLICY);
    expect(body.sandbox.endpoint).toBe('http://127.0.0.1:3676');
  });

  it('is idempotent: same user key returns the same sandbox', async () => {
    const app = testApp();
    const first = (await acquire(app, { userKey: 'alice' })).json();
    const second = (await acquire(app, { userKey: 'alice' })).json();
    expect(second.sandbox.sandboxId).toBe(first.sandbox.sandboxId);
  });

  it('gives different user keys different sandboxes', async () => {
    const app = testApp();
    const alice = (await acquire(app, { userKey: 'alice' })).json();
    const bob = (await acquire(app, { userKey: 'bob' })).json();
    expect(bob.sandbox.sandboxId).not.toBe(alice.sandbox.sandboxId);
  });

  it('stores a policy override, including explicit null for archive', async () => {
    const res = await acquire(testApp(), {
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
    const res = await acquire(testApp(), {
      userKey: 'alice',
      policy: { archiveAfterSeconds: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/stopAfterSeconds/);
  });

  it('rejects a malformed body', async () => {
    const res = await acquire(testApp(), { policy: {} });
    expect(res.statusCode).toBe(400);
  });
});
