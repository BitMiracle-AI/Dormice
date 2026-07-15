import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import {
  CONSOLE_HEADER,
  hashPassword,
  mintSession,
  mintSessionSecret,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifyPassword,
  verifySession,
} from '../auth';
import { loadConfig } from '../config';
import { migrateDb, openDb } from '../db/db';
import { FakeExecutor } from '../executor/fake';
import { KeyedQueue } from '../keyed-queue';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const TOKEN = 'test-token-test-token-test-token';
const USERNAME = 'operator';
const PASSWORD = 'correct horse battery';

function testApp(consoleDistDir?: string) {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const config = loadConfig({
    DORMICE_DB_PATH: ':memory:',
    DORMICE_API_TOKEN: TOKEN,
  });
  return buildApp({
    config,
    db,
    executor: new FakeExecutor(),
    locks: new KeyedQueue(),
    logger: false,
    consoleDistDir,
  });
}

type TestApp = ReturnType<typeof testApp>;

/** A minimal built console: an index.html and one hashed asset. */
function fixtureDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dormice-consoledist-'));
  writeFileSync(join(dir, 'index.html'), '<html>dormice console</html>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log("ui")');
  return dir;
}

async function setup(
  app: TestApp,
  { token = TOKEN, username = USERNAME, password = PASSWORD } = {},
) {
  return app.inject({
    method: 'POST',
    url: '/console/auth/setup',
    payload: { token, username, password },
  });
}

async function login(
  app: TestApp,
  { username = USERNAME, password = PASSWORD } = {},
) {
  return app.inject({
    method: 'POST',
    url: '/console/auth/login',
    payload: { username, password },
  });
}

/** The Set-Cookie value for the session cookie, parsed by fastify's helper. */
function sessionCookie(res: { cookies: Array<Record<string, unknown>> }) {
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  expect(cookie).toBeDefined();
  return cookie as { value: string } & Record<string, unknown>;
}

describe('password hashing', () => {
  it('round-trips and rejects a wrong password', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword('not the password', stored)).toBe(false);
  });

  it('salts: two hashes of the same password differ', async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it('rejects garbage stored values instead of throwing', async () => {
    expect(await verifyPassword(PASSWORD, '')).toBe(false);
    expect(await verifyPassword(PASSWORD, 'bcrypt$whatever')).toBe(false);
  });
});

describe('session mint/verify', () => {
  const SECRET = mintSessionSecret();

  it('round-trips a fresh session', () => {
    expect(verifySession(SECRET, mintSession(SECRET))).toBe(true);
  });

  it('rejects an expired session', () => {
    const past = Date.now() - (SESSION_TTL_SECONDS + 10) * 1000;
    expect(verifySession(SECRET, mintSession(SECRET, past))).toBe(false);
  });

  it('rejects a tampered expiry: the HMAC covers it', () => {
    const value = mintSession(SECRET);
    const [exp, mac] = value.split('.');
    const later = `${Number(exp) + 3600}.${mac}`;
    expect(verifySession(SECRET, later)).toBe(false);
  });

  it('rejects garbage and sessions minted under another secret', () => {
    expect(verifySession(SECRET, 'not-a-session')).toBe(false);
    expect(verifySession(SECRET, '')).toBe(false);
    expect(verifySession(SECRET, mintSession(mintSessionSecret()))).toBe(false);
  });
});

describe('POST /console/auth/status', () => {
  it('reports whether setup has happened', async () => {
    const app = testApp();
    const before = await app.inject({
      method: 'POST',
      url: '/console/auth/status',
      payload: {},
    });
    expect(before.json()).toEqual({ accountExists: false });
    await setup(app);
    const after = await app.inject({
      method: 'POST',
      url: '/console/auth/status',
      payload: {},
    });
    expect(after.json()).toEqual({ accountExists: true });
  });
});

describe('POST /console/auth/setup', () => {
  it('rejects a wrong token without creating anything', async () => {
    const app = testApp();
    const res = await setup(app, { token: 'wrong-token-wrong-token-wrong-tk' });
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toHaveLength(0);
    expect((await login(app)).statusCode).toBe(409);
  });

  it('creates the account and signs the caller in', async () => {
    const app = testApp();
    const res = await setup(app);
    expect(res.statusCode).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(cookie.path).toBe('/');
    expect(cookie.maxAge).toBe(SESSION_TTL_SECONDS);
  });

  it('refuses a short password', async () => {
    const res = await setup(testApp(), { password: 'short' });
    expect(res.statusCode).toBe(400);
  });

  it('re-setup overwrites the account and voids old sessions', async () => {
    const app = testApp();
    const first = sessionCookie(await setup(app));
    // The recovery path: the token alone resets username and password.
    const res = await setup(app, {
      username: 'renamed',
      password: 'brand-new-pass',
    });
    expect(res.statusCode).toBe(200);
    expect((await list(app, first.value)).statusCode).toBe(401);
    expect(
      (await login(app, { username: 'renamed', password: 'brand-new-pass' }))
        .statusCode,
    ).toBe(200);
    expect((await login(app)).statusCode).toBe(401);
  });
});

async function list(
  app: TestApp,
  cookieValue: string,
  headers: Record<string, string> = { [CONSOLE_HEADER]: '1' },
) {
  return app.inject({
    method: 'POST',
    url: '/listSandboxes',
    cookies: { [SESSION_COOKIE]: cookieValue },
    headers,
    payload: {},
  });
}

describe('POST /console/auth/login', () => {
  it('answers 409 before setup — an honest pointer, not a guess counted', async () => {
    const res = await login(testApp());
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('setup');
  });

  it('rejects wrong credentials without setting a cookie', async () => {
    const app = testApp();
    await setup(app);
    const wrongPass = await login(app, { password: 'wrong password' });
    expect(wrongPass.statusCode).toBe(401);
    expect(wrongPass.cookies).toHaveLength(0);
    const wrongUser = await login(app, { username: 'someone-else' });
    expect(wrongUser.statusCode).toBe(401);
  });

  it('signs in with the right credentials', async () => {
    const app = testApp();
    await setup(app);
    const res = await login(app);
    expect(res.statusCode).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.maxAge).toBe(SESSION_TTL_SECONDS);
  });
});

describe('login throttle over the wire', () => {
  it('backs off after repeated failures — even the right credential waits', async () => {
    const app = testApp();
    await setup(app);
    for (let i = 0; i < 8; i++) {
      const res = await login(app, { password: 'wrong password' });
      expect([401, 429]).toContain(res.statusCode);
    }
    const blocked = await login(app);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().message).toContain('retry in');
    // Setup shares the same counters: guessing tokens is the same game.
    expect((await setup(app)).statusCode).toBe(429);
  });

  it('a success clears the slate', async () => {
    const app = testApp();
    await setup(app);
    for (let i = 0; i < 4; i++) {
      await login(app, { password: 'wrong password' });
    }
    expect((await login(app)).statusCode).toBe(200);
    expect((await login(app, { password: 'wrong password' })).statusCode).toBe(
      401,
    );
  });
});

describe('cookie-authenticated API access', () => {
  it('a fresh session cookie opens the native API', async () => {
    const app = testApp();
    await setup(app);
    const cookie = sessionCookie(await login(app));
    const res = await list(app, cookie.value);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sandboxes: [] });
  });

  it('the cookie alone is not enough: the console header is required', async () => {
    const app = testApp();
    await setup(app);
    const cookie = sessionCookie(await login(app));
    const res = await list(app, cookie.value, {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects a tampered cookie', async () => {
    const app = testApp();
    await setup(app);
    const cookie = sessionCookie(await login(app));
    const res = await list(app, `${cookie.value}ff`);
    expect(res.statusCode).toBe(401);
  });

  it('rejects any cookie while no account exists', async () => {
    // A cookie minted under some secret proves nothing when the ledger has
    // no account (e.g. the ledger was recreated).
    const res = await list(testApp(), mintSession(mintSessionSecret()));
    expect(res.statusCode).toBe(401);
  });

  it('does not open the E2B surface: that has its own auth', async () => {
    const app = testApp();
    await setup(app);
    const cookie = sessionCookie(await login(app));
    const res = await app.inject({
      method: 'GET',
      url: '/e2b/api/v2/sandboxes',
      cookies: { [SESSION_COOKIE]: cookie.value },
      headers: { [CONSOLE_HEADER]: '1' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /console/envdToken', () => {
  async function mint(
    app: TestApp,
    cookieValue: string,
    headers: Record<string, string> = { [CONSOLE_HEADER]: '1' },
  ) {
    return app.inject({
      method: 'POST',
      url: '/console/envdToken',
      cookies: { [SESSION_COOKIE]: cookieValue },
      headers,
      payload: { sandboxId: 'sb-terminal' },
    });
  }

  it('a session cookie mints the exact token the envd surface accepts', async () => {
    const app = testApp();
    await setup(app);
    const cookie = sessionCookie(await login(app));
    const res = await mint(app, cookie.value);
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

  it('goes through the API-wide arbiter: no console header, no token', async () => {
    const app = testApp();
    await setup(app);
    const cookie = sessionCookie(await login(app));
    const res = await mint(app, cookie.value, {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects a tampered cookie', async () => {
    const app = testApp();
    await setup(app);
    const cookie = sessionCookie(await login(app));
    const res = await mint(app, `${cookie.value}ff`);
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /console/auth/logout', () => {
  it('clears the session cookie', async () => {
    const res = await testApp().inject({
      method: 'POST',
      url: '/console/auth/logout',
    });
    expect(res.statusCode).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie.value).toBe('');
  });
});

describe('GET / — the bare-origin redirect', () => {
  it('sends a browser (html Accept) to /console/', async () => {
    const res = await testApp(fixtureDist()).inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/console/');
  });

  it('keeps the honest 404 for non-browser clients', async () => {
    // curl's default is Accept: */* — no html, no redirect.
    const res = await testApp(fixtureDist()).inject({
      method: 'GET',
      url: '/',
      headers: { accept: '*/*' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain('not found');
  });

  it('redirects even when the console is not built — the 404 there points at pnpm build', async () => {
    const res = await testApp().inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(302);
  });
});

describe('static console at /console', () => {
  it('serves index.html and assets from the injected dist', async () => {
    const app = testApp(fixtureDist());
    const index = await app.inject({ method: 'GET', url: '/console/' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('dormice console');
    const asset = await app.inject({
      method: 'GET',
      url: '/console/assets/app-abc123.js',
    });
    expect(asset.statusCode).toBe(200);
  });

  it('falls back to index.html for client-side routes (SPA)', async () => {
    const app = testApp(fixtureDist());
    const res = await app.inject({
      method: 'GET',
      url: '/console/sandboxes/deep',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('dormice console');
  });

  it('answers an honest 404 when the console is not built', async () => {
    const res = await testApp().inject({ method: 'GET', url: '/console' });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain('pnpm build');
  });
});
