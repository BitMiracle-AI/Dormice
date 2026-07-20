import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { migrateDb, openDb } from './db/db';
import { findById } from './db/ledger';
import { getOrCreateSigningSecret } from './db/secrets';
import { mintEnvdToken } from './e2b/protocol';
import { FakeExecutor } from './executor/fake';
import { KeyedQueue } from './keyed-queue';
import { parseSandboxHost } from './sandbox-proxy';
import { scanOnce } from './scanner';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const TOKEN = 'test-token-test-token-test-token';
const DOMAIN = 'sbx.dormice.test';

/**
 * The proxy triages by Host header in front of Fastify's router, so
 * app.inject() never reaches it — these tests listen on a real port and
 * speak raw HTTP with a spoofed Host, which is exactly how traffic from a
 * wildcard-DNS reverse proxy looks.
 */
describe('sandbox port proxy', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  async function listeningApp() {
    const db = openDb(':memory:');
    migrateDb(db, MIGRATIONS);
    const config = loadConfig({
      DORMICE_DB_PATH: ':memory:',
      DORMICE_NODE_ID: 'node-test',
      DORMICE_API_TOKEN: TOKEN,
      DORMICE_SANDBOX_DOMAIN: DOMAIN,
    });
    const executor = new FakeExecutor();
    const locks = new KeyedQueue();
    const app = buildApp({ config, db, executor, locks, logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => app.close());
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('no port');
    }
    return { app, db, executor, locks, port: address.port };
  }

  /** Raw request with an explicit Host header (fetch refuses to set one). */
  function rawRequest(
    port: number,
    opts: {
      method?: string;
      path: string;
      host: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<{
    status: number;
    body: string;
    headers: http.IncomingHttpHeaders;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: opts.method ?? 'GET',
          path: opts.path,
          headers: { host: opts.host, ...opts.headers },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body,
              headers: res.headers,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(opts.body);
    });
  }

  function rawGet(
    port: number,
    path: string,
    host: string,
  ): Promise<{ status: number; body: string }> {
    return rawRequest(port, { path, host });
  }

  async function createSandbox(port: number): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/e2b/api/sandboxes`, {
      method: 'POST',
      headers: {
        'x-api-key': `e2b_${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ timeout: 3600 }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      sandboxID: string;
      domain?: string;
    };
    // The domain field is getHost's raw material — configured, so present.
    expect(created.domain).toBe(DOMAIN);
    return created.sandboxID;
  }

  it('parses sandbox hosts and nothing else', () => {
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    expect(parseSandboxHost(`8000-${id}.${DOMAIN}`, DOMAIN)).toEqual({
      port: 8000,
      sandboxId: id,
    });
    // The header's own :port tail is the daemon's port, not the sandbox's.
    expect(parseSandboxHost(`8000-${id}.${DOMAIN}:3676`, DOMAIN)).toEqual({
      port: 8000,
      sandboxId: id,
    });
    expect(parseSandboxHost(`8000-${id}.other.test`, DOMAIN)).toBeNull();
    expect(parseSandboxHost(`${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parseSandboxHost(`0-${id}.${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parseSandboxHost(`8000-not-a-uuid.${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parseSandboxHost(undefined, DOMAIN)).toBeNull();
  });

  it('routes a sandbox Host into the sandbox, transparently', async () => {
    const t = await listeningApp();
    const sandboxId = await createSandbox(t.port);
    const host = `8000-${sandboxId}.${DOMAIN}`;
    const res = await rawGet(t.port, '/hello?x=1', host);
    expect(res.status).toBe(200);
    const echo = JSON.parse(res.body);
    expect(echo.sandboxId).toBe(sandboxId);
    expect(echo.path).toBe('/hello?x=1');
    // Host travels unrewritten — the transparent-proxy promise.
    expect(echo.host).toBe(host);
  });

  it('refuses an unknown sandbox with 502 and leaves other hosts to Fastify', async () => {
    const t = await listeningApp();
    const unknown = await rawGet(
      t.port,
      '/x',
      `8000-01234567-89ab-cdef-0123-456789abcdef.${DOMAIN}`,
    );
    expect(unknown.status).toBe(502);
    expect(JSON.parse(unknown.body).message).toContain('not found');

    // A non-sandbox Host lands in the normal router.
    const native = await rawGet(t.port, '/healthz', 'localhost');
    expect(native.status).toBe(200);
    expect(JSON.parse(native.body)).toEqual({ status: 'ok' });
  });

  it('wakes a frozen sandbox on traffic — autoResume, applied to the web', async () => {
    const t = await listeningApp();
    const sandboxId = await createSandbox(t.port);
    // Freeze the real way — the idle scanner, told it is later — so the
    // ledger and reality move together, exactly the state traffic finds.
    const row = findById(t.db, sandboxId);
    const later = new Date(
      Date.now() + ((row?.freezeAfterSeconds ?? 0) + 60) * 1000,
    );
    await scanOnce(t.db, t.executor, t.locks, later);
    expect(t.executor.stateOf(sandboxId)).toBe('paused');

    const res = await rawGet(t.port, '/warm', `3000-${sandboxId}.${DOMAIN}`);
    expect(res.status).toBe(200);
    expect(t.executor.stateOf(sandboxId)).toBe('running');
  });

  it('carves /files on the envd port out of the proxy — browser-direct upload, end to end', async () => {
    const t = await listeningApp();
    const sandboxId = await createSandbox(t.port);
    const host = `49983-${sandboxId}.${DOMAIN}`;

    // The preflight reaches Fastify's open CORS answer, not a container dial.
    const preflight = await rawRequest(t.port, {
      method: 'OPTIONS',
      path: '/files',
      host,
      headers: {
        origin: 'https://app.example.test',
        'access-control-request-method': 'POST',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');

    // A signed multipart POST, exactly the URL + body shape a browser
    // builds from the SDK's uploadUrl — no headers beyond content-type.
    const token = mintEnvdToken(getOrCreateSigningSecret(t.db), sandboxId);
    const path = '/home/user/probe/a.txt';
    const exp = Math.floor(Date.now() / 1000) + 300;
    const sig = `v1_${createHash('sha256')
      .update([path, 'write', '', token, String(exp)].join(':'), 'utf8')
      .digest('base64')
      .replace(/=+$/, '')}`;
    const boundary = 'proxy-carveout-boundary';
    const body = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${path}"`,
      'Content-Type: text/plain',
      '',
      'straight from the browser\n',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const up = await rawRequest(t.port, {
      method: 'POST',
      path: `/files?path=${encodeURIComponent(path)}&signature=${encodeURIComponent(sig)}&signature_expiration=${exp}`,
      host,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(up.status).toBe(200);
    expect(JSON.parse(up.body)).toEqual([
      { name: 'a.txt', type: 'file', path },
    ]);
    expect(up.headers['access-control-allow-origin']).toBe('*');

    // A ranged read through the same door — how a <video> tag actually
    // consumes a signed downloadUrl: Range in, 206 + content-range out.
    const readSig = `v1_${createHash('sha256')
      .update([path, 'read', '', token, String(exp)].join(':'), 'utf8')
      .digest('base64')
      .replace(/=+$/, '')}`;
    const ranged = await rawRequest(t.port, {
      path: `/files?path=${encodeURIComponent(path)}&signature=${encodeURIComponent(readSig)}&signature_expiration=${exp}`,
      host,
      headers: { range: 'bytes=0-7' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.body).toBe('straight');
    expect(ranged.headers['content-range']).toBe('bytes 0-7/26');
    expect(ranged.headers['accept-ranges']).toBe('bytes');
    expect(ranged.headers['access-control-allow-origin']).toBe('*');

    // Only /files is carved out: any other path on the envd port still
    // dials the container (the fake's echo upstream answers, proving the
    // proxy handled it, not Fastify).
    const other = await rawGet(t.port, '/health', host);
    expect(other.status).toBe(200);
    expect(JSON.parse(other.body)).toMatchObject({ sandboxId });
  });

  it('passes WebSocket upgrades through, both directions', async () => {
    const t = await listeningApp();
    const sandboxId = await createSandbox(t.port);
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(t.port, '127.0.0.1', () => {
        socket.write(
          [
            'GET /ws HTTP/1.1',
            `Host: 5173-${sandboxId}.${DOMAIN}`,
            'Connection: Upgrade',
            'Upgrade: websocket',
            '',
            '',
          ].join('\r\n'),
        );
      });
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('101') && !buffer.includes('marco')) {
          // Handshake done — the fake upstream echoes raw bytes back.
          socket.write('marco');
        }
        if (buffer.includes('marco')) {
          socket.end();
          resolve(buffer);
        }
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error('upgrade timed out')), 5000);
    });
    expect(echoed).toContain('101');
    expect(echoed).toContain('marco');
  });
});
