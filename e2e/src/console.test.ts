import { describe, expect, inject, it } from 'vitest';

// The web console, black-box: plain fetch against the built daemon, the
// same requests a browser would make. The daemon serves packages/console/dist
// (pnpm build ran before this suite), so this also proves the monorepo
// path hop in main.ts survives the dist layout.
//
// The tests run in file order on purpose: they walk the account's real
// story — no account, setup with the token, password logins, reset — and
// only this file touches the account, so the other suites (Bearer-only)
// never race it.

const endpoint = () => inject('dormiceEndpoint');

const USERNAME = 'operator';
const PASSWORD = 'e2e console password';

async function post(path: string, body: unknown, cookie?: string) {
  return fetch(`${endpoint()}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** "name=value" from the login/setup response, what a browser would send back. */
function cookieOf(res: Response): string {
  const setCookie = res.headers.getSetCookie();
  expect(setCookie).toHaveLength(1);
  const cookie = setCookie[0]?.split(';')[0];
  if (!cookie) throw new Error('no session cookie in response');
  return cookie;
}

async function listSandboxes(cookie: string, withHeader = true) {
  return fetch(`${endpoint()}/listSandboxes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      ...(withHeader ? { 'x-dormice-console': '1' } : {}),
    },
    body: '{}',
  });
}

describe('web console over a real daemon', () => {
  it('serves the built SPA at /console/, with assets under /console/', async () => {
    const res = await fetch(`${endpoint()}/console/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<title>Dormice 控制台</title>');
    // The base path is baked in at build time — a bare /assets reference
    // would 404 behind the daemon's /console prefix.
    expect(html).toContain('/console/assets/');
  });

  it('falls back to the SPA for client-side routes', async () => {
    const res = await fetch(`${endpoint()}/console/login`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Dormice 控制台</title>');
  });

  it('starts with no account, and login says so honestly', async () => {
    const status = await post('/console/auth/status', {});
    expect(await status.json()).toEqual({ accountExists: false });
    const res = await post('/console/auth/login', {
      username: USERNAME,
      password: PASSWORD,
    });
    expect(res.status).toBe(409);
  });

  it('refuses setup with a wrong token', async () => {
    const res = await post('/console/auth/setup', {
      token: 'w'.repeat(64),
      username: USERNAME,
      password: PASSWORD,
    });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('setup with the API token creates the account and signs in', async () => {
    const res = await post('/console/auth/setup', {
      token: inject('dormiceToken'),
      username: USERNAME,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    const list = await listSandboxes(cookieOf(res));
    expect(list.status).toBe(200);
    const status = await post('/console/auth/status', {});
    expect(await status.json()).toEqual({ accountExists: true });
  });

  it('rejects a login with the wrong password', async () => {
    const res = await post('/console/auth/login', {
      username: USERNAME,
      password: 'not the password',
    });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('login yields a session cookie that opens the native API', async () => {
    const res = await post('/console/auth/login', {
      username: USERNAME,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    const list = await listSandboxes(cookieOf(res));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { sandboxes: unknown[] };
    expect(Array.isArray(body.sandboxes)).toBe(true);
  });

  it('the cookie without the console header stays locked out', async () => {
    const res = await post('/console/auth/login', {
      username: USERNAME,
      password: PASSWORD,
    });
    const list = await listSandboxes(cookieOf(res), false);
    expect(list.status).toBe(401);
  });

  it('re-setup with the token resets the account and voids old sessions', async () => {
    const before = cookieOf(
      await post('/console/auth/login', {
        username: USERNAME,
        password: PASSWORD,
      }),
    );
    const reset = await post('/console/auth/setup', {
      token: inject('dormiceToken'),
      username: 'renamed',
      password: 'a brand new password',
    });
    expect(reset.status).toBe(200);
    // The forgot-password semantics, observed on the wire: the old session
    // and the old password are both dead, the new pair works.
    expect((await listSandboxes(before)).status).toBe(401);
    const oldLogin = await post('/console/auth/login', {
      username: USERNAME,
      password: PASSWORD,
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await post('/console/auth/login', {
      username: 'renamed',
      password: 'a brand new password',
    });
    expect(newLogin.status).toBe(200);
    expect((await listSandboxes(cookieOf(newLogin))).status).toBe(200);
  });
});
