import { describe, expect, it } from 'vitest';
import { CONSOLE_HEADER, SESSION_COOKIE } from '../auth';
import { TEST_TOKEN, testGateway } from '../testing';

type TestApp = ReturnType<typeof testGateway>['app'];

const authed = { authorization: `Bearer ${TEST_TOKEN}` };

function rpc(app: TestApp, url: string, payload: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url, headers: authed, payload });
}

/** Mint through the wire and hand back everything a test needs. */
async function mint(app: TestApp, name: string, expiresAt?: string) {
  const res = await rpc(app, '/createApiKey', {
    name,
    ...(expiresAt ? { expiresAt } : {}),
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  return {
    id: body.apiKey.id as string,
    token: body.token as string,
    apiKey: body.apiKey,
  };
}

/**
 * Whether a credential opens the sandbox gate. The verb behind it needs
 * no node: listSandboxes over an empty fleet is an empty list with nobody
 * silent — a real answer, "you are through the door"; a 401 is not.
 */
const useKey = (app: TestApp, token: string, url = '/listSandboxes') =>
  app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  });
const OPENED = 200;

describe('API keys on the gateway', () => {
  it('mints a 64-hex token, shown once and never stored in the view', async () => {
    const { app } = testGateway();
    const res = await rpc(app, '/createApiKey', { name: 'ci' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.apiKey).toMatchObject({
      name: 'ci',
      prefix: body.token.slice(0, 8),
      lastUsedAt: null,
      expiresAt: null,
      disabledAt: null,
      revokedAt: null,
    });
    // The view carries no secret — not the token, not its hash.
    expect(JSON.stringify(body.apiKey)).not.toContain(body.token);
    expect(Object.keys(body.apiKey)).not.toContain('keyHash');
  });

  it('a minted key opens the sandbox gate on both faces; revoking closes it on the next request', async () => {
    const { app } = testGateway();
    const { id, token } = await mint(app, 'ci');

    expect((await useKey(app, token)).statusCode).toBe(OPENED);
    // The E2B face judges the same credential, under its own convention.
    const e2b = await app.inject({
      method: 'GET',
      url: '/e2b/api/v2/sandboxes',
      headers: { 'x-api-key': `e2b_${token}` },
    });
    expect(e2b.statusCode).toBe(200);
    expect(e2b.json()).toEqual([]);

    expect((await rpc(app, '/revokeApiKey', { id })).json()).toEqual({
      revoked: true,
    });
    expect((await useKey(app, token)).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/e2b/api/v2/sandboxes',
          headers: { 'x-api-key': `e2b_${token}` },
        })
      ).statusCode,
    ).toBe(401);

    // The fleet token is the bootstrap credential: revocation never touches it.
    expect((await useKey(app, TEST_TOKEN)).statusCode).toBe(OPENED);
  });

  it('refuses a second active key under the same name with a 409, and frees the name after revoke', async () => {
    const { app } = testGateway();
    const { id } = await mint(app, 'ci');
    const dup = await rpc(app, '/createApiKey', { name: 'ci' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toMatch(/'ci' already exists/);

    await rpc(app, '/revokeApiKey', { id });
    expect((await rpc(app, '/createApiKey', { name: 'ci' })).statusCode).toBe(
      200,
    );
  });

  it('revoke is idempotent: an unknown or already-revoked id answers { revoked: false }', async () => {
    const { app } = testGateway();
    expect((await rpc(app, '/revokeApiKey', { id: 'ghost' })).json()).toEqual({
      revoked: false,
    });
    const { id } = await mint(app, 'ci');
    await rpc(app, '/revokeApiKey', { id });
    expect((await rpc(app, '/revokeApiKey', { id })).json()).toEqual({
      revoked: false,
    });
  });

  it('lists every key ever minted, revoked rows included, newest first', async () => {
    const { app } = testGateway();
    const { id } = await mint(app, 'old');
    await rpc(app, '/revokeApiKey', { id });
    await mint(app, 'new');

    const keys = (await rpc(app, '/listApiKeys')).json().apiKeys;
    expect(keys).toHaveLength(2);
    expect(keys[0].name).toBe('new');
    expect(keys[0].revokedAt).toBeNull();
    expect(keys[1].name).toBe('old');
    expect(keys[1].revokedAt).not.toBeNull();
  });

  it('stamps lastUsedAt on first use and throttles the write to 60s granularity', async () => {
    const { app } = testGateway();
    const { token } = await mint(app, 'ci');

    await useKey(app, token);
    const first = (await rpc(app, '/listApiKeys')).json().apiKeys[0];
    expect(first.lastUsedAt).not.toBeNull();

    // A second use inside the 60s window must not move the stamp.
    await useKey(app, token);
    const second = (await rpc(app, '/listApiKeys')).json().apiKeys[0];
    expect(second.lastUsedAt).toBe(first.lastUsedAt);
  });

  it('disable parks the key reversibly: 401 while disabled, open again after enable', async () => {
    const { app } = testGateway();
    const { id, token } = await mint(app, 'ci');
    expect((await useKey(app, token)).statusCode).toBe(OPENED);

    const disabled = (
      await rpc(app, '/updateApiKey', { id, disabled: true })
    ).json().apiKey;
    expect(disabled.disabledAt).not.toBeNull();
    expect((await useKey(app, token)).statusCode).toBe(401);

    // Disabling twice is idempotent: the original stamp stays.
    const again = (
      await rpc(app, '/updateApiKey', { id, disabled: true })
    ).json().apiKey;
    expect(again.disabledAt).toBe(disabled.disabledAt);

    const enabled = (
      await rpc(app, '/updateApiKey', { id, disabled: false })
    ).json().apiKey;
    expect(enabled.disabledAt).toBeNull();
    expect((await useKey(app, token)).statusCode).toBe(OPENED);
  });

  it('expiry closes the door: a past expiresAt is 401, clearing it reopens', async () => {
    const { app } = testGateway();
    const past = new Date(Date.now() - 1000).toISOString();
    const { id, token } = await mint(app, 'ttl', past);
    expect((await useKey(app, token)).statusCode).toBe(401);

    const cleared = (
      await rpc(app, '/updateApiKey', { id, expiresAt: null })
    ).json().apiKey;
    expect(cleared.expiresAt).toBeNull();
    expect((await useKey(app, token)).statusCode).toBe(OPENED);

    const future = new Date(Date.now() + 3600_000).toISOString();
    await rpc(app, '/updateApiKey', { id, expiresAt: future });
    expect((await useKey(app, token)).statusCode).toBe(OPENED);
  });

  it('normalizes expiresAt on write: wire precision variants land as toISOString()', async () => {
    const { app } = testGateway();
    const { apiKey } = await mint(app, 'ttl', '2030-01-01T00:00:00Z');
    expect(apiKey.expiresAt).toBe('2030-01-01T00:00:00.000Z');
  });

  it('updateApiKey renames, refuses collisions honestly, and leaves history alone', async () => {
    const { app } = testGateway();
    const { id } = await mint(app, 'ci');
    const other = await mint(app, 'laptop');

    const renamed = (
      await rpc(app, '/updateApiKey', { id, name: 'ci-2026' })
    ).json().apiKey;
    expect(renamed.name).toBe('ci-2026');

    // Onto a live name: refused like create.
    const clash = await rpc(app, '/updateApiKey', { id, name: 'laptop' });
    expect(clash.statusCode).toBe(409);

    // Onto a revoked name: revoke freed it.
    await rpc(app, '/revokeApiKey', { id: other.id });
    expect(
      (await rpc(app, '/updateApiKey', { id, name: 'laptop' })).statusCode,
    ).toBe(200);

    // Unknown id is a 404; a revoked row is history, not editable.
    expect(
      (await rpc(app, '/updateApiKey', { id: 'ghost', name: 'x' })).statusCode,
    ).toBe(404);
    const edited = await rpc(app, '/updateApiKey', {
      id: other.id,
      name: 'zombie',
    });
    expect(edited.statusCode).toBe(409);
    expect(edited.json().message).toMatch(/rotation history/);
  });

  it('a no-op patch changes nothing', async () => {
    const { app } = testGateway();
    const { id } = await mint(app, 'ci');
    const before = (await rpc(app, '/listApiKeys')).json().apiKeys;
    const res = await rpc(app, '/updateApiKey', {
      id,
      name: 'ci',
      disabled: false,
    });
    expect(res.statusCode).toBe(200);
    expect((await rpc(app, '/listApiKeys')).json().apiKeys).toEqual(before);
  });

  it('carries expiresAt from mint into the list', async () => {
    const { app } = testGateway();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await mint(app, 'ttl', future);
    const keys = (await rpc(app, '/listApiKeys')).json().apiKeys;
    expect(keys[0].expiresAt).toBe(future);
  });

  it('admin-only: a live key gets an honest 403 on every management and node verb, without a lastUsedAt fingerprint', async () => {
    const { app } = testGateway();
    const { id, token } = await mint(app, 'ci');
    const asKey = { authorization: `Bearer ${token}` };

    const attempts = [
      ['/createApiKey', { name: 'evil' }],
      ['/listApiKeys', {}],
      ['/updateApiKey', { id, disabled: true }],
      ['/revokeApiKey', { id }],
      ['/listNodes', {}],
      ['/removeNode', { id: 'node-x' }],
    ] as const;
    for (const [url, payload] of attempts) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: asKey,
        payload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/cannot manage API keys/);
    }

    // The refusals honored nothing: no lastUsedAt fingerprint, key untouched.
    const row = (await rpc(app, '/listApiKeys')).json().apiKeys[0];
    expect(row.lastUsedAt).toBeNull();
    expect(row.disabledAt).toBeNull();
    expect(row.revokedAt).toBeNull();

    // Garbage stays garbage: 401, not 403.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/createApiKey',
          headers: { authorization: 'Bearer not-a-key' },
          payload: { name: 'x' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('a key never passes the nodes gate: a check-in under a minted key is refused', async () => {
    const { app } = testGateway();
    const { token } = await mint(app, 'ci');
    const res = await app.inject({
      method: 'POST',
      url: '/checkIn',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('admin-only: a console session opens the management verbs', async () => {
    const { app } = testGateway();
    const setup = await app.inject({
      method: 'POST',
      url: '/console/auth/setup',
      payload: {
        token: TEST_TOKEN,
        username: 'operator',
        password: 'horse pass',
      },
    });
    expect(setup.statusCode).toBe(200);
    const cookie = setup.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toBeDefined();

    const res = await app.inject({
      method: 'POST',
      url: '/createApiKey',
      headers: { [CONSOLE_HEADER]: '1' },
      cookies: { [SESSION_COOKIE]: (cookie as { value: string }).value },
      payload: { name: 'from-console' },
    });
    expect(res.statusCode).toBe(200);
    expect((await useKey(app, res.json().token)).statusCode).toBe(OPENED);
  });
});
