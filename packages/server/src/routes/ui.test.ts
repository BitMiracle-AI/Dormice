import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import {
  CONSOLE_HEADER,
  mintSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifySession,
} from '../auth';
import { loadConfig } from '../config';
import { migrateDb, openDb } from '../db/db';
import { FakeExecutor } from '../executor/fake';
import { KeyedQueue } from '../keyed-queue';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const TOKEN = 'test-token-test-token-test-token';

function testApp(webDistDir?: string) {
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
    webDistDir,
  });
}

/** A minimal built console: an index.html and one hashed asset. */
function fixtureDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dormice-webdist-'));
  writeFileSync(join(dir, 'index.html'), '<html>dormice console</html>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log("ui")');
  return dir;
}

async function login(app: ReturnType<typeof testApp>, token = TOKEN) {
  return app.inject({
    method: 'POST',
    url: '/ui/auth/login',
    payload: { token },
  });
}

/** The Set-Cookie value for the session cookie, parsed by fastify's helper. */
function sessionCookie(res: { cookies: Array<Record<string, unknown>> }) {
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  expect(cookie).toBeDefined();
  return cookie as { value: string } & Record<string, unknown>;
}

describe('session mint/verify', () => {
  it('round-trips a fresh session', () => {
    expect(verifySession(TOKEN, mintSession(TOKEN))).toBe(true);
  });

  it('rejects an expired session', () => {
    const past = Date.now() - (SESSION_TTL_SECONDS + 10) * 1000;
    expect(verifySession(TOKEN, mintSession(TOKEN, past))).toBe(false);
  });

  it('rejects a tampered expiry: the HMAC covers it', () => {
    const value = mintSession(TOKEN);
    const [exp, mac] = value.split('.');
    const later = `${Number(exp) + 3600}.${mac}`;
    expect(verifySession(TOKEN, later)).toBe(false);
  });

  it('rejects garbage and sessions minted under another token', () => {
    expect(verifySession(TOKEN, 'not-a-session')).toBe(false);
    expect(verifySession(TOKEN, '')).toBe(false);
    expect(
      verifySession(TOKEN, mintSession('other-token-other-token-other-tk')),
    ).toBe(false);
  });
});

describe('POST /ui/auth/login', () => {
  it('rejects a wrong token without setting a cookie', async () => {
    const res = await login(testApp(), 'wrong-token-wrong-token-wrong-tk');
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toHaveLength(0);
  });

  it('sets an httpOnly strict session cookie for the right token', async () => {
    const res = await login(testApp());
    expect(res.statusCode).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(cookie.path).toBe('/');
    expect(cookie.maxAge).toBe(SESSION_TTL_SECONDS);
    expect(verifySession(TOKEN, cookie.value)).toBe(true);
  });
});

describe('cookie-authenticated API access', () => {
  async function list(
    app: ReturnType<typeof testApp>,
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

  it('a fresh session cookie opens the native API', async () => {
    const app = testApp();
    const cookie = sessionCookie(await login(app));
    const res = await list(app, cookie.value);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sandboxes: [] });
  });

  it('the cookie alone is not enough: the console header is required', async () => {
    const app = testApp();
    const cookie = sessionCookie(await login(app));
    const res = await list(app, cookie.value, {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects a tampered cookie', async () => {
    const res = await list(testApp(), `${mintSession(TOKEN)}ff`);
    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired cookie', async () => {
    const past = Date.now() - (SESSION_TTL_SECONDS + 10) * 1000;
    const res = await list(testApp(), mintSession(TOKEN, past));
    expect(res.statusCode).toBe(401);
  });

  it('does not open the E2B surface: that has its own auth', async () => {
    const app = testApp();
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

describe('POST /ui/auth/logout', () => {
  it('clears the session cookie', async () => {
    const res = await testApp().inject({
      method: 'POST',
      url: '/ui/auth/logout',
    });
    expect(res.statusCode).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie.value).toBe('');
  });
});

describe('static console at /ui', () => {
  it('serves index.html and assets from the injected dist', async () => {
    const app = testApp(fixtureDist());
    const index = await app.inject({ method: 'GET', url: '/ui/' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('dormice console');
    const asset = await app.inject({
      method: 'GET',
      url: '/ui/assets/app-abc123.js',
    });
    expect(asset.statusCode).toBe(200);
  });

  it('falls back to index.html for client-side routes (SPA)', async () => {
    const app = testApp(fixtureDist());
    const res = await app.inject({ method: 'GET', url: '/ui/sandboxes/deep' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('dormice console');
  });

  it('answers an honest 404 when the console is not built', async () => {
    const res = await testApp().inject({ method: 'GET', url: '/ui' });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain('pnpm build');
  });
});
