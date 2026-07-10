import { describe, expect, inject, it } from 'vitest';

// The web console, black-box: plain fetch against the built daemon, the
// same requests a browser would make. The daemon serves packages/web/dist
// (pnpm build ran before this suite), so this also proves the monorepo
// path hop in main.ts survives the dist layout.

const endpoint = () => inject('dormiceEndpoint');

async function loginCookie(token: string): Promise<string> {
  const res = await fetch(`${endpoint()}/ui/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.getSetCookie();
  expect(setCookie).toHaveLength(1);
  // "name=value; Path=/; ..." -> "name=value", what a browser would send back.
  const cookie = setCookie[0]?.split(';')[0];
  if (!cookie) throw new Error('no session cookie in login response');
  return cookie;
}

describe('web console over a real daemon', () => {
  it('serves the built SPA at /ui/, with assets under /ui/', async () => {
    const res = await fetch(`${endpoint()}/ui/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<title>Dormice</title>');
    // The base path is baked in at build time — a bare /assets reference
    // would 404 behind the daemon's /ui prefix.
    expect(html).toContain('/ui/assets/');
  });

  it('falls back to the SPA for client-side routes', async () => {
    const res = await fetch(`${endpoint()}/ui/login`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Dormice</title>');
  });

  it('rejects a login with the wrong token', async () => {
    const res = await fetch(`${endpoint()}/ui/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'w'.repeat(64) }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('login yields a session cookie that opens the native API', async () => {
    const cookie = await loginCookie(inject('dormiceToken'));
    const res = await fetch(`${endpoint()}/listSandboxes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'x-dormice-console': '1',
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sandboxes: unknown[] };
    expect(Array.isArray(body.sandboxes)).toBe(true);
  });

  it('the cookie without the console header stays locked out', async () => {
    const cookie = await loginCookie(inject('dormiceToken'));
    const res = await fetch(`${endpoint()}/listSandboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});
