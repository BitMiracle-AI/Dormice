import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { KeyedQueue } from '@dormice/server/keyed-queue';
import { parseSandboxHost } from '@dormice/shared';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGatewayApp } from './app';
import { type AskVerb, httpAsk, httpAskNode } from './ask';
import { NameCache } from './cache';
import { loadConfig } from './config';
import { migrateDb, openDb } from './db/db';
import { ensureSettings } from './db/settings';
import { Finder } from './find';
import { Fleet } from './fleet';
import { checkInOf, type reading } from './testing';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const TOKEN = 'fleet-token-fleet-token-fleet-token-fleet';
/** The sandbox domain group the fake nodes' proxies key on — a canonical domain and one inbound alias. */
const DOMAINS = ['sbx.test', 'alias.test'];
const DOMAIN = DOMAINS[0] as string;

/**
 * A node as the gateway sees one: the daemon's wire for the handful of
 * verbs the gateway touches, over a real socket. Every sandbox it holds is
 * a row in `sandboxes`; every request it received is in `hits`.
 */
/** One clock for every fake node's createdAt: a later create is newer wherever it landed, so a merged newest-first page has one right order. */
let births = 0;

class FakeNode {
  readonly sandboxes = new Map<
    string,
    { id: string; name: string; createdAt: string; files: Map<string, string> }
  >();
  readonly hits: Array<{
    path: string;
    auth: string | undefined;
    /** Set on a hit the node's port proxy took (a sandbox Host) — and whether it was an upgrade. */
    host?: string | undefined;
    upgrade?: boolean;
  }> = [];
  creates = 0;
  endpoint = '';
  /** How long a destroy takes to answer — a slow node holding the name's slot. */
  destroyTakesMs = 0;
  /** How long the list verbs take to answer — a busy node the merged lists must not wait forever for. */
  listTakesMs = 0;
  private readonly server: http.Server;

  constructor(readonly id: string) {
    this.server = http.createServer((req, res) => {
      let text = '';
      req.on('data', (c) => {
        text += c;
      });
      req.on('end', () => this.answer(req, res, text));
    });
    // The daemon's port proxy takes upgrades for sandbox hosts (a dev
    // server's WebSocket); this double's "container" echoes bytes after a
    // bare 101. Anything else is cut, as the daemon cuts it.
    this.server.on('upgrade', (req, socket) => {
      socket.on('error', () => socket.destroy());
      const sandbox = parseSandboxHost(req.headers.host, DOMAINS);
      this.hits.push({
        path: req.url ?? '/',
        auth: req.headers.authorization,
        host: req.headers.host,
        upgrade: true,
      });
      if (!sandbox || !this.byId(sandbox.sandboxId)) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n');
        return;
      }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
      socket.pipe(socket);
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  lookups(): number {
    return this.hits.filter((h) => h.path === '/lookupSandbox').length;
  }

  byId(id: string) {
    return [...this.sandboxes.values()].find((s) => s.id === id);
  }

  /**
   * This double's signing secret is its own id: a signature
   * `sig-<node>-<sandboxId>` speaks for that sandbox here and for nothing
   * anywhere else — as a real node's HMAC, keyed by its own secret, does.
   */
  bySignature(query: string) {
    const signature = new URLSearchParams(query).get('signature') ?? '';
    const prefix = `sig-${this.id}-`;
    return signature.startsWith(prefix)
      ? this.byId(signature.slice(prefix.length))
      : undefined;
  }

  // Inferred return type on purpose: the early `return json(...)` exits
  // read as statements, and an explicit void would flag each one.
  private answer(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    text: string,
  ) {
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? url;
    const auth =
      req.headers.authorization ??
      (req.headers['x-api-key'] as string | undefined);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // The daemon's port proxy as the gateway meets it: keyed on the Host
    // it was sent, dialing the sandbox it holds — here an echo of what
    // arrived (the fake executor's upstream does the same), or the
    // daemon's own 502 for an id it lacks. Unauthenticated, as the real
    // one is.
    const sandboxHost = parseSandboxHost(req.headers.host, DOMAINS);
    if (sandboxHost) {
      this.hits.push({ path, auth, host: req.headers.host });
      const sandbox = this.byId(sandboxHost.sandboxId);
      if (!sandbox) {
        return json(502, {
          message: `sandbox ${sandboxHost.sandboxId} not found`,
        });
      }
      return json(200, {
        proxied: this.id,
        host: req.headers.host,
        port: sandboxHost.port,
        url,
        auth: auth ?? null,
      });
    }
    this.hits.push({ path, auth });
    if (path === '/files') {
      // The daemon's signed file door as the gateway meets it: judged by
      // the query alone, no headers wanted, CORS on every answer — and
      // here an echo of what arrived.
      const sandbox = this.bySignature(url.slice(url.indexOf('?') + 1));
      res.writeHead(sandbox ? 200 : 401, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      res.end(
        JSON.stringify(
          sandbox
            ? {
                signedDoor: this.id,
                sandboxId: sandbox.id,
                method: req.method,
                url,
                auth: auth ?? null,
                bodyBytes: text.length,
              }
            : { code: 'unauthenticated', message: 'invalid signature' },
        ),
      );
      return;
    }
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (path.startsWith('/e2b/envd/')) {
      return json(200, {
        envd: this.id,
        sandboxId: req.headers['e2b-sandbox-id'],
        accessToken: req.headers['x-access-token'],
        url,
      });
    }
    if (path.startsWith('/e2b/api/')) {
      if (auth !== `e2b_${TOKEN}`)
        return json(401, { code: 401, message: 'invalid API key' });
      if (path === '/e2b/api/v2/sandboxes' && req.method === 'GET') {
        // The daemon's v2 list: newest first, offset in nextToken, the
        // next offset in the x-next-token header when there is more.
        const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
        const limit = Number(query.get('limit') ?? '100');
        const offset = Number(query.get('nextToken') ?? '0') || 0;
        const all = [...this.sandboxes.values()].sort((a, b) =>
          a.createdAt < b.createdAt ? 1 : -1,
        );
        const page = all.slice(offset, offset + limit);
        const headers: Record<string, string> = {
          'content-type': 'application/json',
        };
        if (offset + limit < all.length) {
          headers['x-next-token'] = String(offset + limit);
        }
        const answer = () => {
          res.writeHead(200, headers);
          res.end(
            JSON.stringify(
              page.map((s) => ({
                sandboxID: s.id,
                clientID: this.id,
                alias: s.name,
                state: 'running',
                startedAt: s.createdAt,
              })),
            ),
          );
        };
        if (this.listTakesMs > 0) setTimeout(answer, this.listTakesMs);
        else answer();
        return;
      }
      const m = path.match(/^\/e2b\/api\/sandboxes(?:\/([^/]+))?(\/.*)?$/);
      if (!m) return json(404, { code: 404, message: 'not found' });
      const [, id, rest] = m;
      if (id === undefined) {
        if (req.method !== 'POST')
          return json(404, { code: 404, message: 'not found' });
        const metadata = body.metadata as { name?: string } | undefined;
        const name = metadata?.name ?? `e2b-${randomUUID()}`;
        // The daemon's create is idempotent on metadata.name.
        const sandbox = this.sandboxes.get(name) ?? this.create(name);
        return json(201, { sandboxID: sandbox.id, templateID: 'base' });
      }
      const sandbox = this.byId(id);
      if (!sandbox) return json(404, { code: 404, message: 'not found' });
      if (rest) return json(200, { path: url, sandboxID: sandbox.id });
      if (req.method === 'DELETE') {
        this.sandboxes.delete(sandbox.name);
        res.writeHead(204);
        res.end();
        return;
      }
      return json(200, { sandboxID: sandbox.id, alias: sandbox.name });
    }
    if (auth !== `Bearer ${TOKEN}`)
      return json(401, { message: 'missing or invalid API token' });
    const name = body.name as string | undefined;
    const found = name === undefined ? undefined : this.sandboxes.get(name);
    switch (path) {
      case '/envdToken': {
        // The daemon's HMAC stands in as a string only this node would mint.
        return json(200, {
          envdAccessToken: `envd-${this.id}-${String(body.sandboxId)}`,
        });
      }
      case '/templateUsers': {
        // This double records no template per sandbox: nothing here uses one.
        return json(200, { sandboxNames: [] });
      }
      case '/listSandboxes':
      case '/listSandboxMetrics':
      case '/listSandboxImages': {
        // The daemon's three fleet-wide lists, as the gateway merges them.
        const all = [...this.sandboxes.values()];
        const answer = () =>
          json(
            200,
            path === '/listSandboxes'
              ? { sandboxes: all.map((s) => this.view(s)) }
              : path === '/listSandboxMetrics'
                ? {
                    samples: all.map((s) => ({
                      sandboxName: s.name,
                      sandboxId: s.id,
                      sample: SAMPLE,
                    })),
                  }
                : {
                    images: all.map((s) => ({
                      sandboxName: s.name,
                      sandboxId: s.id,
                      image: 'img:1',
                      nextImage: 'img:1',
                      upgradable: false,
                    })),
                  },
          );
        if (this.listTakesMs > 0) setTimeout(answer, this.listTakesMs);
        else answer();
        return;
      }
      case '/getHostMetrics':
      case '/getHostMetricsHistory': {
        // A machine's reading, forwarded whole: an echo says which machine
        // answered and what it was sent.
        return json(200, { hostOf: this.id, verb: path, body });
      }
      case '/lookupSandbox': {
        const signed = body.signed as { query: string } | undefined;
        const sandbox =
          signed !== undefined
            ? this.bySignature(signed.query)
            : 'id' in body
              ? this.byId(body.id as string)
              : found;
        return json(
          200,
          sandbox
            ? {
                found: true,
                sandbox: {
                  id: sandbox.id,
                  name: sandbox.name,
                  state: 'active',
                },
              }
            : { found: false },
        );
      }
      case '/acquireSandbox': {
        if (name === undefined) return json(400, { message: 'name required' });
        const sandbox = found ?? this.create(name);
        return json(200, {
          status: 'ready',
          created: found === undefined,
          sandbox: { id: sandbox.id, name, nodeId: this.id },
        });
      }
      case '/destroySandbox': {
        const destroy = () => {
          if (name !== undefined) this.sandboxes.delete(name);
          json(200, { destroyed: found !== undefined });
        };
        if (this.destroyTakesMs > 0) {
          setTimeout(destroy, this.destroyTakesMs);
          return;
        }
        return destroy();
      }
      case '/execCommand': {
        if (!found)
          return json(404, {
            message: `no sandbox named "${name}" — acquire it first`,
          });
        return json(200, { stdout: `${this.id}: ${String(body.command)}` });
      }
      case '/writeFile': {
        if (!found)
          return json(404, {
            message: `no sandbox named "${name}" — acquire it first`,
          });
        found.files.set(String(body.path), String(body.content));
        return json(200, { written: true });
      }
      case '/readFile': {
        if (!found)
          return json(404, {
            message: `no sandbox named "${name}" — acquire it first`,
          });
        const content = found.files.get(String(body.path));
        if (content === undefined)
          return json(404, { message: `no such file: ${String(body.path)}` });
        return json(200, { content });
      }
      default:
        return json(404, { message: `route ${req.method} ${url} not found` });
    }
  }

  private create(name: string) {
    this.creates += 1;
    births += 1;
    const sandbox = {
      id: randomUUID(),
      name,
      createdAt: new Date(
        Date.UTC(2026, 8, 15) + births * 60_000,
      ).toISOString(),
      files: new Map(),
    };
    this.sandboxes.set(name, sandbox);
    return sandbox;
  }

  /** The daemon's sandbox object for one of this double's rows — enough of it to pass the shared schema. */
  private view(s: { id: string; name: string; createdAt: string }) {
    return {
      id: s.id,
      name: s.name,
      state: 'active',
      nodeId: this.id,
      endpoint: this.endpoint,
      policy: {
        freezeAfterSeconds: 300,
        stopAfterSeconds: null,
        archiveAfterSeconds: null,
      },
      spec: { cpus: 1, memoryGb: 2, diskGb: 10 },
      template: null,
      metadata: {},
      createdAt: s.createdAt,
      lastActiveAt: s.createdAt,
      lastExit: null,
    };
  }
}

/** One measurable sandbox's reading, the same for every row of every double. */
const SAMPLE = {
  timestamp: '2026-09-15T00:00:00.000Z',
  cpuCount: 1,
  cpuUsedPct: 5,
  memUsedBytes: 100,
  memTotalBytes: 2048,
  memCacheBytes: 10,
  swapUsedBytes: null,
  swapTotalBytes: null,
  diskUsedBytes: 1000,
  diskTotalBytes: 10_000,
};

interface Harness {
  endpoint: string;
  nodes: FakeNode[];
  cache: NameCache;
  fleet: Fleet;
  checkIn(
    node: FakeNode,
    over?: Parameters<typeof reading>[0] & {
      intervalSeconds?: number;
      configVersion?: number | null;
    },
  ): Promise<void>;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function gateway(
  nodeIds: string[],
  env: Record<string, string> = {},
  opts: {
    /** Collects the gateway's own log lines (JSON, one per entry) when a test asserts on what it says. */
    logs?: string[];
    /** How the gateway asks nodes on its own account — a test shortens its patience for the slow-node case. */
    ask?: AskVerb;
  } = {},
): Promise<Harness> {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const config = loadConfig({
    DORMICE_API_TOKEN: TOKEN,
    DORMICE_GATEWAY_DB_PATH: ':memory:',
    // A laptop running the suite is not the machine under judgment.
    DORMICE_GATEWAY_NODE_CPU_LIMIT_PCT: '100',
    ...env,
  });
  ensureSettings(db, config);
  const fleet = new Fleet(db);
  const cache = new NameCache();
  const finder = new Finder(fleet, cache, httpAskNode(TOKEN), {
    warn: () => {},
  });
  const logs = opts.logs;
  const app = buildGatewayApp({
    config,
    db,
    fleet,
    finder,
    locks: new KeyedQueue(),
    logger:
      logs === undefined
        ? false
        : pino({ level: 'info' }, { write: (line: string) => logs.push(line) }),
    build: null,
    ask: opts.ask,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const endpoint = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const nodes = await Promise.all(
    nodeIds.map((id) => new FakeNode(id).start()),
  );
  const harness: Harness = {
    endpoint,
    nodes,
    cache,
    fleet,
    checkIn: async (node, over = {}) => {
      const res = await fetch(`${endpoint}/checkIn`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(checkInOf(node.id, node.endpoint, over)),
      });
      expect(res.status).toBe(200);
    },
    close: async () => {
      await app.close();
      for (const node of nodes) await node.stop();
    },
  };
  for (const node of nodes) await harness.checkIn(node);
  harnesses.push(harness);
  return harness;
}

async function rpc(
  h: Harness,
  path: string,
  payload: unknown = {},
  token = TOKEN,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(`${h.endpoint}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    headers: res.headers,
  };
}

const message = (r: { body: unknown }) =>
  (r.body as { message: string }).message;
const sandboxOf = (r: { body: unknown }) =>
  (r.body as { created: boolean; sandbox: { id: string; nodeId: string } })
    .sandbox;

/** Builds a sandbox directly on a node, behind the gateway's back. */
async function stage(node: FakeNode, name: string) {
  const res = await fetch(`${node.endpoint}/acquireSandbox`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
  return sandboxOf({ body: await res.json() });
}

/** Polls until the probe answers something — cache verification runs off the request path. */
async function until<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the door', () => {
  it('/healthz is open; everything else wants the fleet token, on the check-in too', async () => {
    const h = await gateway([]);
    const health = await fetch(`${h.endpoint}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', build: null });
    expect((await rpc(h, '/listNodes', {}, 'w'.repeat(40))).status).toBe(401);
    const bare = await fetch(`${h.endpoint}/checkIn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(checkInOf('x', 'http://127.0.0.1:1')),
    });
    expect(bare.status).toBe(401);
    expect((await rpc(h, '/acquireSandbox', { name: 'x' }, 'bad')).status).toBe(
      401,
    );
  });

  it('refuses an absolute-form request target before routing', async () => {
    const h = await gateway([]);
    const url = new URL(h.endpoint);
    const answer = await new Promise<string>((resolve, reject) => {
      let text = '';
      const socket = net.connect(Number(url.port), url.hostname, () => {
        socket.write(
          `POST http://evil.example/execCommand HTTP/1.1\r\nhost: gateway\r\nconnection: close\r\n\r\n`,
        );
      });
      socket.on('data', (c) => {
        text += c;
      });
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
    });
    expect(answer).toContain('HTTP/1.1 400');
    expect(answer).toContain('origin-form');
  });
});

describe('check-in and the node verbs', () => {
  it('a check-in joins the fleet; listNodes shows what it said; a later check-in moves the endpoint; the row outlives the memory', async () => {
    const h = await gateway(['b']);
    const listed = (await rpc(h, '/listNodes')).body as {
      nodes: Array<Record<string, unknown>>;
    };
    expect(listed.nodes).toHaveLength(1);
    expect(listed.nodes[0]).toMatchObject({
      id: 'b',
      endpoint: h.nodes[0]?.endpoint,
      reachable: true,
      intervalSeconds: 15,
      placedSinceCheckIn: 0,
      build: { commit: 'abc1234' },
    });
    expect(
      (listed.nodes[0]?.reading as { host: { cpuCount: number } }).host
        .cpuCount,
    ).toBe(8);
    const moved = new FakeNode('b');
    await moved.start();
    // Inside the first reporter's interval a different address is a second
    // daemon under one DORMICE_NODE_ID, refused with why; the first keeps
    // the id. An interval later the same report is a move.
    const twin = await rpc(
      h,
      '/checkIn',
      checkInOf('b', moved.endpoint, { active: 3 }),
    );
    expect(twin.status).toBe(409);
    expect(message(twin)).toMatch(/two daemons share one DORMICE_NODE_ID/);
    expect(h.fleet.get('b')?.endpoint).toBe(h.nodes[0]?.endpoint);
    const first = h.fleet.get('b');
    if (!first) throw new Error('node lost');
    first.lastCheckInAt = new Date(Date.now() - 16_000);
    await h.checkIn(moved, { active: 3 });
    expect(h.fleet.get('b')?.endpoint).toBe(moved.endpoint);
    expect(h.fleet.get('b')?.reading?.sandboxes.byState.active).toBe(3);
    await moved.stop();
    // A malformed check-in is a 400 naming the trouble, not a join.
    const bad = await rpc(h, '/checkIn', { nodeId: 'z' });
    expect(bad.status).toBe(400);
    expect(h.fleet.get('z')).toBeUndefined();
    // An endpoint the gateway could not use is refused at the wire (shared
    // endpointSchema has the measurement): undici takes the endpoint as
    // the request's origin and throws on a path — a node every lookup
    // would find and no forward could reach. A trailing slash is merely
    // dropped; the two ends must agree byte for byte.
    const pathy = await rpc(
      h,
      '/checkIn',
      checkInOf('p', 'http://10.0.0.9:80/dormice'),
    );
    expect(pathy.status).toBe(400);
    expect(message(pathy)).toMatch(/an endpoint is an origin/);
    expect(h.fleet.get('p')).toBeUndefined();
    await rpc(h, '/checkIn', checkInOf('s', 'http://10.0.0.9:80/'));
    expect(h.fleet.get('s')?.endpoint).toBe('http://10.0.0.9:80');
  });

  it('removeNode forgets the node and everything cached on it; a removed node that checks in again re-joins', async () => {
    const h = await gateway(['b', 'c']);
    const created = sandboxOf(await rpc(h, '/acquireSandbox', { name: 'x' }));
    expect(h.cache.getByName('x')?.nodeId).toBe(created.nodeId);
    // Still checking in: refused, with what to do instead — its names
    // would be placed elsewhere before its next check-in and come back on
    // two nodes.
    const live = await rpc(h, '/removeNode', { id: created.nodeId });
    expect(live.status).toBe(409);
    expect(message(live)).toMatch(/checked in \ds ago — it is running/);
    expect(h.fleet.get(created.nodeId)).toBeDefined();
    // Silent for two of its intervals: down, and removable.
    const silent = h.fleet.get(created.nodeId);
    if (!silent) throw new Error('node lost');
    silent.lastCheckInAt = new Date(Date.now() - 31_000);
    expect((await rpc(h, '/removeNode', { id: created.nodeId })).body).toEqual({
      removed: true,
    });
    expect(h.cache.getByName('x')).toBeUndefined();
    expect(
      ((await rpc(h, '/listNodes')).body as { nodes: unknown[] }).nodes,
    ).toHaveLength(1);
    expect((await rpc(h, '/removeNode', { id: 'nobody' })).body).toEqual({
      removed: false,
    });
    const back = h.nodes.find((n) => n.id === created.nodeId);
    if (!back) throw new Error('node lost');
    await h.checkIn(back);
    expect(
      ((await rpc(h, '/listNodes')).body as { nodes: unknown[] }).nodes,
    ).toHaveLength(2);
  });

  it('two nodes on one endpoint are warned about when it arises or changes, not at every check-in; and once more when it stops', async () => {
    const logs: string[] = [];
    const h = await gateway(['b'], {}, { logs });
    const shared = h.nodes[0]?.endpoint ?? '';
    const warned = () =>
      logs.filter((l) => l.includes('two nodes report the same endpoint'));
    // Three check-ins from c at b's address: one warning, not three.
    for (let i = 0; i < 3; i += 1) {
      await rpc(h, '/checkIn', checkInOf('c', shared));
    }
    expect(warned()).toHaveLength(1);
    expect(JSON.parse(warned()[0] ?? '{}')).toMatchObject({
      nodeId: 'c',
      alsoReportedBy: ['b'],
    });
    // A third node at the address is news; c's next check-in is news
    // again, because the set it shares with changed.
    await rpc(h, '/checkIn', checkInOf('d', shared));
    expect(warned()).toHaveLength(2);
    await rpc(h, '/checkIn', checkInOf('c', shared));
    expect(warned()).toHaveLength(3);
    expect(JSON.parse(warned()[2] ?? '{}')).toMatchObject({
      nodeId: 'c',
      alsoReportedBy: ['b', 'd'],
    });
    // c moves to an address of its own (an interval later, so the move is
    // taken): said once, as the end of the situation.
    const c = h.fleet.get('c');
    if (!c) throw new Error('node lost');
    c.lastCheckInAt = new Date(Date.now() - 16_000);
    await rpc(h, '/checkIn', checkInOf('c', 'http://10.0.0.99:80'));
    await rpc(h, '/checkIn', checkInOf('c', 'http://10.0.0.99:80'));
    expect(
      logs.filter((l) => l.includes('no longer shares its endpoint')),
    ).toHaveLength(1);
    expect(warned()).toHaveLength(3);
  });

  it('a node behind on configuration is said to be so once per gap, not at every check-in; catching up is said once', async () => {
    const logs: string[] = [];
    const h = await gateway(['b'], {}, { logs });
    const node = h.nodes[0];
    if (!node) throw new Error('node lost');
    const rides = () =>
      logs.filter((l) => l.includes('the bundle rides on this answer'));
    const caughtUp = () =>
      logs.filter((l) =>
        l.includes('now runs the current configuration version'),
      );
    // The harness's first check-in reported version 1 = current: nothing
    // said. Three check-ins on version 0 while current is 1: one line.
    expect(rides()).toHaveLength(0);
    for (let i = 0; i < 3; i += 1) {
      await rpc(
        h,
        '/checkIn',
        checkInOf('b', node.endpoint, { configVersion: 0 }),
      );
    }
    expect(rides()).toHaveLength(1);
    expect(JSON.parse(rides()[0] ?? '{}')).toMatchObject({
      nodeId: 'b',
      runs: 0,
      current: 1,
    });
    // An edit widens the gap: news again, once.
    await rpc(h, '/updateSettings', { pidsLimit: 512 });
    await rpc(
      h,
      '/checkIn',
      checkInOf('b', node.endpoint, { configVersion: 0 }),
    );
    await rpc(
      h,
      '/checkIn',
      checkInOf('b', node.endpoint, { configVersion: 0 }),
    );
    expect(rides()).toHaveLength(2);
    // The node applies it: said once, then nothing while it stays current.
    await rpc(
      h,
      '/checkIn',
      checkInOf('b', node.endpoint, { configVersion: 2 }),
    );
    await rpc(
      h,
      '/checkIn',
      checkInOf('b', node.endpoint, { configVersion: 2 }),
    );
    expect(caughtUp()).toHaveLength(1);
    expect(rides()).toHaveLength(2);
  });

  it("a row that never checked in (the import pre-creates one) is removed at once; a node that checked in seconds ago is refused — as of its row after a restart too (fleet.test), with no grace for the gateway's own age", async () => {
    const h = await gateway(['b']);
    // The row as the import leaves it, in the shape fleet.ts loads for it:
    // known, never heard from, nothing to protect.
    const b = h.fleet.get('b');
    if (!b) throw new Error('node lost');
    b.lastCheckInAt = null;
    b.intervalSeconds = null;
    b.reading = null;
    expect((await rpc(h, '/removeNode', { id: 'b' })).body).toEqual({
      removed: true,
    });
    // Checked in seconds ago — to this process, or per its row to the one
    // before: the same refusal.
    await h.checkIn(h.nodes[0] as FakeNode);
    const live = await rpc(h, '/removeNode', { id: 'b' });
    expect(live.status).toBe(409);
    expect(message(live)).toMatch(/^node b checked in \ds ago — it is running/);
    expect(h.fleet.get('b')).toBeDefined();
  });
});

describe('acquire: placing and finding', () => {
  it('a new name lands on the emptiest node by active density, under the fleet token, and is cached: the second acquire asks only its node, once', async () => {
    const h = await gateway(['a', 'b']);
    const [a, b] = h.nodes as [FakeNode, FakeNode];
    await h.checkIn(a, { active: 10, cores: 8 });
    await h.checkIn(b, { active: 1, cores: 8 });
    const first = await rpc(h, '/acquireSandbox', { name: 'alice' });
    expect(first.status).toBe(200);
    expect(sandboxOf(first).nodeId).toBe('b');
    expect(b.creates).toBe(1);
    expect(a.creates).toBe(0);
    expect(b.hits.find((hit) => hit.path === '/acquireSandbox')?.auth).toBe(
      `Bearer ${TOKEN}`,
    );
    // Both nodes were asked once — the name was new — and the answer's id
    // is cached beside the name.
    expect(a.lookups()).toBe(1);
    expect(b.lookups()).toBe(1);
    expect(h.cache.getById(sandboxOf(first).id)?.nodeId).toBe('b');
    const again = await rpc(h, '/acquireSandbox', { name: 'alice' });
    expect(sandboxOf(again).id).toBe(sandboxOf(first).id);
    expect((again.body as { created: boolean }).created).toBe(false);
    // A creator confirms its cache hit with that one node (by id) before
    // trusting it; the other node hears nothing.
    expect(a.lookups()).toBe(1);
    expect(b.lookups()).toBe(2);
    expect(h.fleet.get('b')?.placedSinceCheckIn).toBe(1);
  });

  it('a name whose sandbox its node has since removed on its own is a placement again: the cached node is asked first, the gate judges afresh, the count moves — on either face', async () => {
    const h = await gateway(['a', 'b'], {
      DORMICE_GATEWAY_NODE_ACTIVE_LIMIT: '2',
    });
    const [a, b] = h.nodes as [FakeNode, FakeNode];
    await h.checkIn(a, { active: 0 });
    await h.checkIn(b, { active: 1 });
    const born = sandboxOf(await rpc(h, '/acquireSandbox', { name: 'ttl' }));
    expect(born.nodeId).toBe('a');
    expect(h.cache.getByName('ttl')?.nodeId).toBe('a');
    // The node reaps it on its own (an E2B deadline kill is the scanner's
    // routine): the gateway hears nothing, the entry is stale. Meanwhile a
    // fills up and b empties — the gate must judge afresh, not wake.
    a.sandboxes.delete('ttl');
    await h.checkIn(a, { active: 2 });
    await h.checkIn(b, { active: 0 });
    const again = await rpc(h, '/acquireSandbox', { name: 'ttl' });
    expect(again.status).toBe(200);
    expect(sandboxOf(again).nodeId).toBe('b');
    expect((again.body as { created: boolean }).created).toBe(true);
    // Nothing was rebuilt on the full node; the placement is counted where
    // it landed and the cache follows.
    expect(a.creates).toBe(1);
    expect(h.fleet.get('b')?.placedSinceCheckIn).toBe(1);
    expect(h.cache.getByName('ttl')?.nodeId).toBe('b');

    // The E2B face takes the same slot and the same confirmation.
    const create = (name: string) =>
      fetch(`${h.endpoint}/e2b/api/sandboxes`, {
        method: 'POST',
        headers: {
          'x-api-key': `e2b_${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ metadata: { name } }),
      });
    await h.checkIn(a, { active: 0 });
    await h.checkIn(b, { active: 2 });
    expect((await create('ttl-e2b')).status).toBe(201);
    expect(h.cache.getByName('ttl-e2b')?.nodeId).toBe('a');
    a.sandboxes.delete('ttl-e2b');
    await h.checkIn(a, { active: 2 });
    await h.checkIn(b, { active: 0 });
    expect((await create('ttl-e2b')).status).toBe(201);
    expect(h.cache.getByName('ttl-e2b')?.nodeId).toBe('b');
    expect(h.fleet.get('b')?.placedSinceCheckIn).toBe(1);
  });

  it("an acquire whose client left while it waited for the name's slot asks no node and builds nothing", async () => {
    const h = await gateway(['a']);
    const a = h.nodes[0] as FakeNode;
    await rpc(h, '/acquireSandbox', { name: 'q' });
    // A destroy holds the slot; an acquire queues behind it, and its
    // client gives up while queued.
    a.destroyTakesMs = 400;
    const destroying = rpc(h, '/destroySandbox', { name: 'q' });
    await until(() =>
      a.hits.some((hit) => hit.path === '/destroySandbox') ? true : undefined,
    );
    const asked = a.lookups();
    const left = new AbortController();
    const abandoned = fetch(`${h.endpoint}/acquireSandbox`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'q' }),
      signal: left.signal,
    }).then(
      () => 'answered',
      () => 'left',
    );
    await new Promise((r) => setTimeout(r, 50));
    left.abort();
    expect(await abandoned).toBe('left');
    expect((await destroying).body).toEqual({ destroyed: true });
    // The slot is free; the abandoned acquire ran and did nothing.
    await new Promise((r) => setTimeout(r, 100));
    expect(a.lookups()).toBe(asked);
    expect(a.creates).toBe(1);
    expect(a.sandboxes.has('q')).toBe(false);
  });

  it('twenty simultaneous acquires of one new name are one create on one node; different names spread', async () => {
    const h = await gateway(['a', 'b']);
    const [a, b] = h.nodes as [FakeNode, FakeNode];
    const burst = await Promise.all(
      Array.from({ length: 20 }, () =>
        rpc(h, '/acquireSandbox', { name: 'burst' }),
      ),
    );
    expect(new Set(burst.map((r) => sandboxOf(r).id)).size).toBe(1);
    expect(a.creates + b.creates).toBe(1);
    expect(
      burst.filter((r) => (r.body as { created: boolean }).created),
    ).toHaveLength(1);

    const spread = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        rpc(h, '/acquireSandbox', { name: `spread-${i}` }),
      ),
    );
    const landed = spread.map((r) => sandboxOf(r).nodeId);
    expect(landed.filter((id) => id === 'a').length).toBeGreaterThan(0);
    expect(landed.filter((id) => id === 'b').length).toBeGreaterThan(0);
  });

  it('a sandbox built behind its back is found by asking: routed at once, re-acquired where it is', async () => {
    const h = await gateway(['a', 'b']);
    const b = h.nodes[1] as FakeNode;
    const staged = sandboxOf(
      await (async () => {
        const res = await fetch(`${b.endpoint}/acquireSandbox`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ name: 'staged' }),
        });
        return { body: await res.json() };
      })(),
    );
    const ran = await rpc(h, '/execCommand', { name: 'staged', command: 'id' });
    expect(ran.status).toBe(200);
    expect((ran.body as { stdout: string }).stdout).toBe('b: id');
    const found = await rpc(h, '/acquireSandbox', { name: 'staged' });
    expect(sandboxOf(found)).toMatchObject({ id: staged.id, nodeId: 'b' });
    expect((found.body as { created: boolean }).created).toBe(false);
  });

  it('a wake is not a placement: it neither counts against the node nor pays a placement back when destroyed — on either face', async () => {
    const h = await gateway(['a', 'b']);
    const [a, b] = h.nodes as [FakeNode, FakeNode];
    await h.checkIn(a, { active: 10 });
    await h.checkIn(b, { active: 1 });
    const placedOnB = () => h.fleet.get('b')?.placedSinceCheckIn;
    // Sandboxes that already live on b: the gateway finds and wakes them
    // there, and b's reading already counts them.
    await stage(b, 'sleepy');
    await stage(b, 'dozy');
    expect(
      sandboxOf(await rpc(h, '/acquireSandbox', { name: 'sleepy' })).nodeId,
    ).toBe('b');
    expect(placedOnB()).toBe(0);
    const e2bWake = await fetch(`${h.endpoint}/e2b/api/sandboxes`, {
      method: 'POST',
      headers: {
        'x-api-key': `e2b_${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ metadata: { name: 'dozy' } }),
    });
    expect(e2bWake.status).toBe(201);
    expect(placedOnB()).toBe(0);
    // A new name placed on b (the emptiest) is counted once.
    expect(
      sandboxOf(await rpc(h, '/acquireSandbox', { name: 'fresh' })).nodeId,
    ).toBe('b');
    expect(placedOnB()).toBe(1);
    // Destroying the woken sandboxes must not pay back a placement that
    // never was: b would be judged one sandbox emptier than it is.
    await rpc(h, '/destroySandbox', { name: 'sleepy' });
    expect(placedOnB()).toBe(1);
    await rpc(h, '/destroySandbox', { name: 'dozy' });
    expect(placedOnB()).toBe(1);
    await rpc(h, '/destroySandbox', { name: 'fresh' });
    expect(placedOnB()).toBe(0);
  });

  it('one name on two nodes is a 409 naming both, for every verb; once one copy is gone the name routes again', async () => {
    const h = await gateway(['a', 'b']);
    const [a, b] = h.nodes as [FakeNode, FakeNode];
    for (const node of [a, b]) {
      await fetch(`${node.endpoint}/acquireSandbox`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'twin' }),
      });
    }
    for (const verb of ['/acquireSandbox', '/execCommand', '/destroySandbox']) {
      const refused = await rpc(h, verb, { name: 'twin' });
      expect(refused.status).toBe(409);
      expect(message(refused)).toContain('exists on nodes a and b');
    }
    expect(h.cache.getByName('twin')).toBeUndefined();
    b.sandboxes.delete('twin');
    const healed = await rpc(h, '/acquireSandbox', { name: 'twin' });
    expect(sandboxOf(healed).nodeId).toBe('a');
  });

  it("a node that checked in again under a new id answers every lookup twice: the 409 says the two ids are one endpoint and names the way out, not 'destroy one copy'", async () => {
    const h = await gateway(['a', 'b']);
    const [a] = h.nodes as [FakeNode, FakeNode];
    expect(
      sandboxOf(await rpc(h, '/acquireSandbox', { name: 'kept' })).nodeId,
    ).toBe('a');
    // The operator renamed DORMICE_NODE_ID on a's machine; the old row stays.
    const renamed = await fetch(`${h.endpoint}/checkIn`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(checkInOf('a-renamed', a.endpoint)),
    });
    expect(renamed.status).toBe(200);
    h.cache.evict({
      id: sandboxOf(await rpc(h, '/acquireSandbox', { name: 'kept' })).id,
      name: 'kept',
      nodeId: 'a',
    });
    const refused = await rpc(h, '/execCommand', {
      name: 'kept',
      command: 'true',
    });
    expect(refused.status).toBe(409);
    expect(message(refused)).toContain(
      `nodes a and a-renamed, which are one endpoint (${a.endpoint})`,
    );
    expect(message(refused)).toContain(
      'removeNode the id that no longer checks in',
    );
    expect(message(refused)).not.toContain('destroy one copy');
  });

  it('a node that does not answer: its cached names 502, and a new name is a 503 with Retry-After naming it — until an operator removes it', async () => {
    const h = await gateway(['a', 'b']);
    const [a, b] = h.nodes as [FakeNode, FakeNode];
    await h.checkIn(a, { active: 1 });
    await h.checkIn(b, { active: 50 });
    const onA = sandboxOf(await rpc(h, '/acquireSandbox', { name: 'on-a' }));
    expect(onA.nodeId).toBe('a');
    await a.stop();
    const cut = await rpc(h, '/execCommand', { name: 'on-a', command: 'x' });
    expect(cut.status).toBe(502);
    expect(message(cut)).toMatch(/did not answer/);
    const fresh = await rpc(h, '/acquireSandbox', { name: 'brand-new' });
    expect(fresh.status).toBe(503);
    expect(fresh.headers.get('retry-after')).toBe('15');
    expect(message(fresh)).toContain('node a did not answer');
    expect(message(fresh)).toContain('cannot be treated as new');
    expect(b.creates).toBe(0);
    // Its socket is dead but its check-in was seconds ago: not yet "down",
    // and removeNode says so. Two of its intervals of silence later it is.
    const early = await rpc(h, '/removeNode', { id: 'a' });
    expect(early.status).toBe(409);
    const silent = h.fleet.get('a');
    if (!silent) throw new Error('node lost');
    silent.lastCheckInAt = new Date(Date.now() - 31_000);
    expect((await rpc(h, '/removeNode', { id: 'a' })).body).toEqual({
      removed: true,
    });
    const placed = await rpc(h, '/acquireSandbox', { name: 'brand-new' });
    expect(placed.status).toBe(200);
    expect(sandboxOf(placed).nodeId).toBe('b');
  });

  it('every node refusing is a 503 that names each one; no node at all says so', async () => {
    const h = await gateway(['a', 'b'], {
      DORMICE_GATEWAY_NODE_ACTIVE_LIMIT: '2',
    });
    const [a, b] = h.nodes as [FakeNode, FakeNode];
    await h.checkIn(a, { active: 2 });
    await h.checkIn(b, { active: 1, diskAvail: 2 ** 30 });
    const refused = await rpc(h, '/acquireSandbox', { name: 'full' });
    expect(refused.status).toBe(503);
    expect(message(refused)).toContain('a: 2 active sandboxes + 0 placed');
    expect(message(refused)).toContain('b: data disk has 1.0 GiB available');
    expect(refused.headers.get('retry-after')).toBe('15');

    const empty = await gateway([]);
    const nobody = await rpc(empty, '/acquireSandbox', { name: 'x' });
    expect(nobody.status).toBe(503);
    expect(message(nobody)).toMatch(/no node has checked in/);
  });
});

describe('using, destroying, and the cache', () => {
  it('envdToken is minted by the node that runs the sandbox, found by id, under the fleet token; an unknown id is a 404', async () => {
    const h = await gateway(['b', 'c']);
    const created = sandboxOf(await rpc(h, '/acquireSandbox', { name: 'x' }));
    const minted = await rpc(h, '/envdToken', { sandboxId: created.id });
    expect(minted.status).toBe(200);
    expect(minted.body).toEqual({
      envdAccessToken: `envd-${created.nodeId}-${created.id}`,
    });
    const home = h.nodes.find((n) => n.id === created.nodeId);
    expect(home?.hits.find((hit) => hit.path === '/envdToken')?.auth).toBe(
      `Bearer ${TOKEN}`,
    );
    const nobody = await rpc(h, '/envdToken', { sandboxId: randomUUID() });
    expect(nobody.status).toBe(404);
    expect(message(nobody)).toMatch(/is on no node/);
  });

  it("files round-trip; a node's 404 for a missing file passes through and the sandbox stays cached", async () => {
    const h = await gateway(['a']);
    const a = h.nodes[0] as FakeNode;
    await rpc(h, '/acquireSandbox', { name: 'w' });
    expect(
      (await rpc(h, '/writeFile', { name: 'w', path: 'a.txt', content: 'hi' }))
        .status,
    ).toBe(200);
    expect(
      (await rpc(h, '/readFile', { name: 'w', path: 'a.txt' })).body,
    ).toEqual({ content: 'hi' });
    const missing = await rpc(h, '/readFile', { name: 'w', path: 'nope' });
    expect(missing.status).toBe(404);
    expect(message(missing)).toBe('no such file: nope');
    // The 404 sent one question to the node, which said yes: the entry stays.
    await until(() => (a.lookups() >= 2 ? true : undefined));
    expect(h.cache.getByName('w')?.nodeId).toBe('a');
    expect(
      (await rpc(h, '/execCommand', { name: 'w', command: 'ok' })).status,
    ).toBe(200);
  });

  it('a destroy the gateway relays forgets the entry; a destroy behind its back is caught by the 404 re-check', async () => {
    const h = await gateway(['a']);
    const a = h.nodes[0] as FakeNode;
    const first = sandboxOf(await rpc(h, '/acquireSandbox', { name: 'd' }));
    expect((await rpc(h, '/destroySandbox', { name: 'd' })).body).toEqual({
      destroyed: true,
    });
    expect(h.cache.getByName('d')).toBeUndefined();
    expect(h.cache.getById(first.id)).toBeUndefined();
    // Placed and destroyed inside one interval: the placement no longer
    // counts against the node — the reading will never show it.
    expect(h.fleet.get('a')?.placedSinceCheckIn).toBe(0);
    expect((await rpc(h, '/destroySandbox', { name: 'd' })).body).toEqual({
      destroyed: false,
    });
    const second = await rpc(h, '/acquireSandbox', { name: 'd' });
    expect((second.body as { created: boolean }).created).toBe(true);
    expect(sandboxOf(second).id).not.toBe(first.id);

    // Behind the gateway's back: the node's own 404 is relayed as it came,
    // the re-check finds the sandbox absent, and the next request asks
    // the fleet afresh — a 404 in the gateway's own words.
    a.sandboxes.delete('d');
    const relayed = await rpc(h, '/execCommand', { name: 'd', command: 'x' });
    expect(relayed.status).toBe(404);
    await until(() =>
      h.cache.getByName('d') === undefined ? true : undefined,
    );
    const before = a.lookups();
    const own = await rpc(h, '/execCommand', { name: 'd', command: 'x' });
    expect(own.status).toBe(404);
    expect(message(own)).toBe('no sandbox named "d" — acquire it first');
    expect(a.lookups()).toBe(before + 1);
  });

  it("the upgrade verbs answer at the door (the gateway's own, routes/upgrade.test.ts), a misspelled verb is a 404, a body without a name a 400", async () => {
    const h = await gateway(['a']);
    const upgrade = await rpc(h, '/checkUpgrade');
    expect(upgrade.status).toBe(200);
    expect(upgrade.body).toMatchObject({ current: null, check: null });
    expect((await rpc(h, '/acquireSandbx', { name: 'x' })).status).toBe(404);
    expect((await rpc(h, '/execCommand', { command: 'x' })).status).toBe(400);
    expect(h.nodes[0]?.hits).toEqual([]);
  });

  it('a name the wire refuses is a 400 at the door on both faces, and no node is asked', async () => {
    const h = await gateway(['a']);
    const long = 'x'.repeat(129);
    const native = await rpc(h, '/acquireSandbox', { name: long });
    expect(native.status).toBe(400);
    expect(message(native)).toMatch(/^invalid name: /);
    expect(
      (await rpc(h, '/execCommand', { name: 7, command: 'x' })).status,
    ).toBe(400);
    const e2b = await fetch(`${h.endpoint}/e2b/api/sandboxes`, {
      method: 'POST',
      headers: {
        'x-api-key': `e2b_${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ metadata: { name: long } }),
    });
    expect(e2b.status).toBe(400);
    expect(await e2b.json()).toMatchObject({
      code: 400,
      message: expect.stringMatching(/^invalid metadata\.name: /),
    });
    expect(h.nodes[0]?.hits).toEqual([]);
  });
});

describe('the E2B faces', () => {
  const e2b = (h: Harness, path: string, init: RequestInit = {}) =>
    fetch(`${h.endpoint}/e2b/api${path}`, {
      ...init,
      headers: {
        'x-api-key': `e2b_${TOKEN}`,
        'content-type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });

  it('control plane: a named create is placed and cached; by-id verbs are found and forwarded under e2b_<token>; the kill forgets the entry; an unnamed create is known by id', async () => {
    const h = await gateway(['a', 'b']);
    const created = await e2b(h, '/sandboxes', {
      method: 'POST',
      body: JSON.stringify({ metadata: { name: 'e2b-named' } }),
    });
    expect(created.status).toBe(201);
    const { sandboxID } = (await created.json()) as { sandboxID: string };
    const entry = h.cache.getById(sandboxID);
    expect(entry?.name).toBe('e2b-named');
    const node = h.nodes.find((n) => n.id === entry?.nodeId);
    if (!node) throw new Error('not placed');
    const info = await e2b(h, `/sandboxes/${sandboxID}`);
    expect(info.status).toBe(200);
    expect(node.hits.at(-1)?.auth).toBe(`e2b_${TOKEN}`);
    const deeper = await e2b(h, `/sandboxes/${sandboxID}/metrics?x=1`, {
      method: 'GET',
    });
    expect(((await deeper.json()) as { path: string }).path).toBe(
      `/e2b/api/sandboxes/${sandboxID}/metrics?x=1`,
    );
    // The same name through the E2B face is the same sandbox (the name slot).
    const again = await e2b(h, '/sandboxes', {
      method: 'POST',
      body: JSON.stringify({ metadata: { name: 'e2b-named' } }),
    });
    expect(((await again.json()) as { sandboxID: string }).sandboxID).toBe(
      sandboxID,
    );
    const killed = await e2b(h, `/sandboxes/${sandboxID}`, {
      method: 'DELETE',
    });
    expect(killed.status).toBe(204);
    expect(h.cache.getById(sandboxID)).toBeUndefined();
    const gone = await e2b(h, `/sandboxes/${sandboxID}`);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({
      code: 404,
      message: `sandbox "${sandboxID}" not found`,
    });

    const anonymous = await e2b(h, '/sandboxes', {
      method: 'POST',
      body: JSON.stringify({ templateID: 'base' }),
    });
    expect(anonymous.status).toBe(201);
    const anon = (await anonymous.json()) as { sandboxID: string };
    expect(h.cache.getById(anon.sandboxID)?.name).toBeNull();
    expect((await e2b(h, `/sandboxes/${anon.sandboxID}`)).status).toBe(200);

    // The list is answered here now (its own suite below): the named and
    // the unnamed sandbox both, from whichever node holds each.
    const listed = await e2b(h, '/v2/sandboxes');
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as Array<{ sandboxID: string }>).map(
        (s) => s.sandboxID,
      ),
    ).toContain(anon.sandboxID);
    const wrongKey = await fetch(`${h.endpoint}/e2b/api/sandboxes`, {
      method: 'POST',
      headers: { 'x-api-key': 'e2b_wrong', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(wrongKey.status).toBe(401);
    expect(await wrongKey.json()).toEqual({
      code: 401,
      message: 'invalid API key',
    });
  });

  it("envd: routed by the E2b-Sandbox-Id header with the caller's own credentials untouched; refusals wear the connect dialect with CORS", async () => {
    const h = await gateway(['a']);
    const created = sandboxOf(await rpc(h, '/acquireSandbox', { name: 'e' }));
    const hit = await fetch(`${h.endpoint}/e2b/envd/files?path=/x`, {
      headers: { 'e2b-sandbox-id': created.id, 'x-access-token': 'hmac-1' },
    });
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual({
      envd: 'a',
      sandboxId: created.id,
      accessToken: 'hmac-1',
      url: '/e2b/envd/files?path=/x',
    });
    const headerless = await fetch(`${h.endpoint}/e2b/envd/files`);
    expect(headerless.status).toBe(401);
    expect(headerless.headers.get('access-control-allow-origin')).toBe('*');
    expect(await headerless.json()).toEqual({
      code: 'unauthenticated',
      message: 'missing E2b-Sandbox-Id header',
    });
    const stranger = await fetch(`${h.endpoint}/e2b/envd/files`, {
      headers: { 'e2b-sandbox-id': randomUUID() },
    });
    expect(stranger.status).toBe(502);
    expect(((await stranger.json()) as { code: string }).code).toBe(
      'unavailable',
    );
    const preflight = await fetch(`${h.endpoint}/e2b/envd/files`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    // The bare signed form is its own face (below): a signature nobody
    // signed is the door's own 401, with CORS.
    const bare = await fetch(`${h.endpoint}/files?signature=x`);
    expect(bare.status).toBe(401);
    expect(bare.headers.get('access-control-allow-origin')).toBe('*');
    expect(((await bare.json()) as { code: string }).code).toBe(
      'unauthenticated',
    );
  });
});

/**
 * A request at the door with a spoofed Host — wildcard-DNS traffic as the
 * reverse proxy hands it over (fetch refuses to set Host, so node:http
 * speaks). `method` and `headers` for the preflight shapes.
 */
function viaHost(
  h: Harness,
  host: string,
  path = '/',
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  const endpoint = new URL(h.endpoint);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: endpoint.hostname,
        port: endpoint.port,
        path,
        method,
        headers: { ...headers, host },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * An upgrade handshake at the door, raw: what came back before the socket
 * closed — a 101 and the echo of `marco`, a refusal's status line, or
 * nothing at all for a socket the gateway cut. `target` is the request
 * target as written on the request line (origin-form by default).
 */
function rawUpgrade(h: Harness, host: string, target = '/ws'): Promise<string> {
  const port = Number(new URL(h.endpoint).port);
  return new Promise((resolve, reject) => {
    let buffer = '';
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        [
          `GET ${target} HTTP/1.1`,
          `Host: ${host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // Handshake done — the fake node's "container" echoes raw bytes back.
      if (buffer.includes(' 101 ') && !buffer.includes('marco')) {
        socket.write('marco');
      }
      if (buffer.includes('marco')) socket.end();
    });
    socket.on('close', () => resolve(buffer));
    socket.on('error', reject);
    setTimeout(() => reject(new Error('upgrade timed out')), 5_000);
  });
}

describe('the sandbox port proxy face', () => {
  it('a sandbox host is forwarded to the node holding the id — Host kept, no credential added, the answer relayed as it came; the path is the sandbox’s whatever it spells', async () => {
    const h = await gateway(['a', 'b'], { DORMICE_SANDBOX_DOMAIN: DOMAIN });
    const created = sandboxOf(await rpc(h, '/acquireSandbox', { name: 'web' }));
    const host = `8000-${created.id}.${DOMAIN}`;
    const res = await viaHost(h, host, '/hello?x=1');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      proxied: created.nodeId,
      host,
      port: 8000,
      url: '/hello?x=1',
      auth: null,
    });
    // A native verb's path under a sandbox host is a path inside the
    // sandbox: the door's own router never sees it, exactly as the
    // daemon's proxy stands in front of its router.
    const verb = await viaHost(h, host, '/acquireSandbox');
    expect(JSON.parse(verb.body)).toMatchObject({
      proxied: created.nodeId,
      url: '/acquireSandbox',
    });
    // The id was cached by the placement: the other node was never asked.
    const elsewhere = h.nodes.find((n) => n.id !== created.nodeId);
    expect(elsewhere?.hits.some((hit) => hit.host !== undefined)).toBe(false);
  });

  it('a sandbox built behind the gateway’s back is found by asking; an id on no node gets the daemon’s proxy answer, 502 { message } without CORS — except on the browser-direct file form, which carries it and whose preflight the door answers itself', async () => {
    const h = await gateway(['a', 'b'], { DORMICE_SANDBOX_DOMAIN: DOMAIN });
    const staged = await stage(h.nodes[1] as FakeNode, 'behind');
    const res = await viaHost(h, `3000-${staged.id}.${DOMAIN}`, '/');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ proxied: 'b', port: 3000 });

    const nobody = await viaHost(h, `8000-${randomUUID()}.${DOMAIN}`, '/');
    expect(nobody.status).toBe(502);
    expect(JSON.parse(nobody.body)).toEqual({
      message: expect.stringMatching(/on no node/),
    });
    expect(nobody.headers['access-control-allow-origin']).toBeUndefined();

    // 49983 /files is the signed-URL form a browser posts to directly; the
    // daemon promises CORS on every answer to it, and the door keeps the
    // promise on its own refusals.
    const files = await viaHost(
      h,
      `49983-${randomUUID()}.${DOMAIN}`,
      '/files?signature=x',
    );
    expect(files.status).toBe(502);
    expect(files.headers['access-control-allow-origin']).toBe('*');
    // Its preflight is the door's own answer, in the node's shape, whether
    // or not the id is anywhere: a browser sends nothing until the
    // preflight passes, so a 502 here would have hidden the refusal above.
    const preflight = await viaHost(
      h,
      `49983-${randomUUID()}.${DOMAIN}`,
      '/files',
      'OPTIONS',
      { 'access-control-request-headers': 'content-type' },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(preflight.headers['access-control-allow-methods']).toBe(
      'GET, POST, OPTIONS',
    );
    expect(preflight.headers['access-control-allow-headers']).toBe(
      'content-type',
    );
    // A known id too — and the node is not asked for it.
    const nodeB = h.nodes[1] as FakeNode;
    const hitsBefore = nodeB.hits.length;
    const known = await viaHost(
      h,
      `49983-${staged.id}.${DOMAIN}`,
      '/files',
      'OPTIONS',
    );
    expect(known.status).toBe(204);
    expect(nodeB.hits.length).toBe(hitsBefore);
    // Only that form: an OPTIONS on any other port is the sandbox's own
    // and rides to it like any request.
    const appOptions = await viaHost(
      h,
      `3000-${staged.id}.${DOMAIN}`,
      '/api',
      'OPTIONS',
    );
    expect(JSON.parse(appOptions.body)).toMatchObject({
      proxied: 'b',
      url: '/api',
    });
    // For a sandbox that exists the form rides to its node whole — the
    // carve-out onto the signed door is the node's own.
    const carved = await viaHost(
      h,
      `49983-${staged.id}.${DOMAIN}`,
      '/files?signature=x',
    );
    expect(JSON.parse(carved.body)).toMatchObject({
      proxied: 'b',
      port: 49983,
      url: '/files?signature=x',
    });
  });

  it('WebSocket upgrades ride through to the node both ways, Host kept; an upgrade for an id on no node is refused with a status line, an absolute-form handshake with a 400; any other upgrade is cut', async () => {
    const h = await gateway(['a'], { DORMICE_SANDBOX_DOMAIN: DOMAIN });
    const created = sandboxOf(await rpc(h, '/acquireSandbox', { name: 'ws' }));
    const host = `5173-${created.id}.${DOMAIN}`;
    const echoed = await rawUpgrade(h, host);
    expect(echoed).toContain(' 101 ');
    expect(echoed).toContain('marco');
    expect(
      h.nodes[0]?.hits.some((hit) => hit.upgrade === true && hit.host === host),
    ).toBe(true);

    const refused = await rawUpgrade(h, `5173-${randomUUID()}.${DOMAIN}`);
    expect(refused).toMatch(/^HTTP\/1\.1 502 /);
    expect(refused).toContain('on no node');

    // The request path's first rule holds on this path too: an absolute-
    // form handshake is refused in the same words, as a status line, and
    // is never replayed into the sandbox.
    const nodeA = h.nodes[0] as FakeNode;
    const hitsBefore = nodeA.hits.length;
    const absolute = await rawUpgrade(h, host, `http://${host}/ws`);
    expect(absolute).toMatch(/^HTTP\/1\.1 400 /);
    expect(absolute).toContain('origin-form');
    expect(nodeA.hits.length).toBe(hitsBefore);

    // Not a sandbox host: nothing said, the socket closed — stock
    // Fastify's behavior for an upgrade it never handles.
    expect(await rawUpgrade(h, 'door.example')).toBe('');
  });

  it('with no domain in force a sandbox host is plain traffic at the router; a domain written at the door engages on the very next request, an alias joins inbound, and clearing disengages — no restart, no check-in to wait for', async () => {
    const h = await gateway(['a']);
    const created = sandboxOf(
      await rpc(h, '/acquireSandbox', { name: 'live' }),
    );
    const host = `8000-${created.id}.${DOMAIN}`;
    const off = await viaHost(h, host, '/x');
    expect(off.status).toBe(404);
    expect(JSON.parse(off.body).message).toMatch(/^route GET \/x not found/);

    expect(
      (await rpc(h, '/updateSettings', { sandboxDomain: DOMAIN })).status,
    ).toBe(200);
    expect(JSON.parse((await viaHost(h, host, '/x')).body)).toMatchObject({
      proxied: 'a',
      url: '/x',
    });

    const alias = DOMAINS[1] as string;
    expect(
      (await rpc(h, '/updateSettings', { sandboxDomainAliases: [alias] }))
        .status,
    ).toBe(200);
    expect(
      JSON.parse((await viaHost(h, `8000-${created.id}.${alias}`, '/y')).body),
    ).toMatchObject({ proxied: 'a', url: '/y' });

    expect(
      (
        await rpc(h, '/updateSettings', {
          sandboxDomain: null,
          sandboxDomainAliases: [],
        })
      ).status,
    ).toBe(200);
    expect((await viaHost(h, host, '/x')).status).toBe(404);
  });
});

describe('the bare signed-URL face', () => {
  it('a signed /files request at the root is routed by asking every node whose signature it is: download and upload reach the node whose sandbox signed it, whole and credential-less; a signature nobody signed is the door’s own 401, no signature the door’s first rule; a silent node makes it a 503', async () => {
    const h = await gateway(['a', 'b']);
    const nodeA = h.nodes[0] as FakeNode;
    const nodeB = h.nodes[1] as FakeNode;
    // Built behind the gateway's back: nothing cached, nothing but the
    // signature to go on — the form the SDK's downloadUrl mints off the
    // door's origin, whatever domain is in force.
    const staged = await stage(nodeB, 'signer');
    const query = `path=out.txt&signature=${encodeURIComponent(`sig-b-${staged.id}`)}&signature_expiration=1`;
    const download = await fetch(`${h.endpoint}/files?${query}`);
    expect(download.status).toBe(200);
    expect(download.headers.get('access-control-allow-origin')).toBe('*');
    expect(await download.json()).toEqual({
      signedDoor: 'b',
      sandboxId: staged.id,
      method: 'GET',
      url: `/files?${query}`,
      auth: null,
      bodyBytes: 0,
    });
    // Every node was asked, once; what b answered is cached by id, so the
    // sandbox's other faces now ask nobody.
    expect(nodeA.lookups()).toBe(1);
    expect(nodeB.lookups()).toBe(1);
    expect(h.cache.getById(staged.id)?.nodeId).toBe('b');
    // An upload: the body rides whole to the same node, once — never
    // "tried" against each node. A signature is no key the cache holds,
    // so each signed request is one round of questions.
    const upload = await fetch(`${h.endpoint}/files?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'x'.repeat(5000),
    });
    expect(upload.status).toBe(200);
    expect(await upload.json()).toMatchObject({
      signedDoor: 'b',
      method: 'POST',
      bodyBytes: 5000,
    });
    expect(nodeA.lookups()).toBe(2);
    expect(nodeB.hits.filter((hit) => hit.path === '/files').length).toBe(2);
    expect(nodeA.hits.some((hit) => hit.path === '/files')).toBe(false);

    // A signature no node's sandbox signed: the door's own 401, in its
    // words and dialect, readable by a browser.
    const forged = await fetch(
      `${h.endpoint}/files?path=out.txt&signature=v1_forged`,
    );
    expect(forged.status).toBe(401);
    expect(forged.headers.get('access-control-allow-origin')).toBe('*');
    expect(await forged.json()).toEqual({
      code: 'unauthenticated',
      message: 'invalid signature',
    });
    // No signature at all: the door's first rule, and no node is asked.
    const asked = nodeA.lookups();
    const bare = await fetch(`${h.endpoint}/files?path=out.txt`);
    expect(bare.status).toBe(401);
    expect(bare.headers.get('access-control-allow-origin')).toBe('*');
    expect(await bare.json()).toEqual({
      code: 'unauthenticated',
      message: 'missing signature query parameter',
    });
    expect(nodeA.lookups()).toBe(asked);
    // The preflight is the door's own answer, as on the envd face.
    const preflight = await fetch(`${h.endpoint}/files`, {
      method: 'OPTIONS',
      headers: { 'access-control-request-headers': 'content-type' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toBe(
      'content-type',
    );

    // A node that does not answer: a signature it may recognize cannot be
    // called invalid — retry. One that another node does recognize still
    // routes: one yes wins over a silence.
    await nodeA.stop();
    const unsure = await fetch(
      `${h.endpoint}/files?path=out.txt&signature=v1_forged`,
    );
    expect(unsure.status).toBe(503);
    expect(unsure.headers.get('retry-after')).toBe('15');
    expect(unsure.headers.get('access-control-allow-origin')).toBe('*');
    expect(((await unsure.json()) as { code: string }).code).toBe(
      'unavailable',
    );
    expect((await fetch(`${h.endpoint}/files?${query}`)).status).toBe(200);
  });
});

describe('the fleet-wide lists and the by-node readings', () => {
  const namesOf = (r: { body: unknown }) =>
    (r.body as { sandboxes: Array<{ name: string; nodeId: string }> })
      .sandboxes;
  const silentOf = (r: { body: unknown }) =>
    (r.body as { silent: Array<{ nodeId: string; why: string }> }).silent;

  async function seeded() {
    const h = await gateway(['c', 'b']);
    // Three names: placement alternates (the emptiest by active density,
    // the in-flight count moving it), so both nodes hold some.
    for (const name of ['s1', 's2', 's3']) {
      expect((await rpc(h, '/acquireSandbox', { name })).status).toBe(200);
    }
    const [c, b] = h.nodes;
    if (!c || !b) throw new Error('nodes lost');
    return { h, b, c };
  }

  it("listSandboxes is every node's list in node-id order, each asked once, with nobody silent", async () => {
    const { h, b, c } = await seeded();
    const listed = await rpc(h, '/listSandboxes');
    expect(listed.status).toBe(200);
    const nodesInOrder = namesOf(listed).map((s) => s.nodeId);
    expect(nodesInOrder).toHaveLength(3);
    expect(nodesInOrder).toEqual([...nodesInOrder].sort());
    expect(
      namesOf(listed)
        .map((s) => s.name)
        .sort(),
    ).toEqual(['s1', 's2', 's3']);
    expect(silentOf(listed)).toEqual([]);
    for (const node of [b, c]) {
      expect(node.hits.filter((x) => x.path === '/listSandboxes')).toHaveLength(
        1,
      );
    }
  });

  it('a node that is down is not dialled and is named silent with the reason; its sandboxes are not in the list', async () => {
    const { h, b, c } = await seeded();
    const down = h.fleet.get('c');
    if (!down) throw new Error('node lost');
    down.lastCheckInAt = new Date(Date.now() - 31_000);
    const listed = await rpc(h, '/listSandboxes');
    expect(listed.status).toBe(200);
    expect(namesOf(listed).every((s) => s.nodeId === 'b')).toBe(true);
    expect(namesOf(listed)).toHaveLength(b.sandboxes.size);
    expect(silentOf(listed)).toEqual([
      {
        nodeId: 'c',
        why: expect.stringMatching(/has not checked in for 3\ds/),
      },
    ]);
    expect(c.hits.filter((x) => x.path === '/listSandboxes')).toHaveLength(0);
  });

  it('a node awaiting its first configuration is not dialled: empty, nothing is said; holding sandboxes, it is named as not listening', async () => {
    const h = await gateway(['b', 'c']);
    const [b, c] = h.nodes;
    if (!b || !c) throw new Error('nodes lost');
    await h.checkIn(c, { configVersion: null, active: 0 });
    let listed = await rpc(h, '/listSandboxes');
    expect(silentOf(listed)).toEqual([]);
    await h.checkIn(c, { configVersion: null, active: 5 });
    listed = await rpc(h, '/listSandboxes');
    expect(silentOf(listed)).toEqual([
      { nodeId: 'c', why: expect.stringMatching(/not listening — it holds 5/) },
    ]);
    expect(c.hits.filter((x) => x.path === '/listSandboxes')).toHaveLength(0);
    expect(b.hits.filter((x) => x.path === '/listSandboxes')).toHaveLength(2);
  });

  it('a node too slow to answer is silent after the merge timeout, and the rest of the list is answered', async () => {
    // The gateway's patience shortened to 300ms: the rule, not the wait.
    const h = await gateway(
      ['b', 'c'],
      {},
      {
        ask: (node, verb, body, schema, options) =>
          httpAsk(TOKEN)(node, verb, body, schema, {
            ...options,
            timeoutMs: 300,
          }),
      },
    );
    const [b, c] = h.nodes;
    if (!b || !c) throw new Error('nodes lost');
    await rpc(h, '/acquireSandbox', { name: 'quick' });
    c.listTakesMs = 2_000;
    const started = Date.now();
    const listed = await rpc(h, '/listSandboxes');
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(listed.status).toBe(200);
    expect(silentOf(listed)).toEqual([
      { nodeId: 'c', why: expect.stringMatching(/timeout|abort/i) },
    ]);
    expect(namesOf(listed).map((s) => s.nodeId)).toEqual(
      namesOf(listed).map(() => 'b'),
    );
  });

  it('listSandboxMetrics and listSandboxImages merge the same way', async () => {
    const { h } = await seeded();
    const metrics = await rpc(h, '/listSandboxMetrics');
    expect(metrics.status).toBe(200);
    const samples = metrics.body as {
      samples: Array<{ sandboxName: string }>;
      silent: unknown[];
    };
    expect(samples.samples.map((s) => s.sandboxName).sort()).toEqual([
      's1',
      's2',
      's3',
    ]);
    expect(samples.silent).toEqual([]);
    const images = await rpc(h, '/listSandboxImages');
    expect(images.status).toBe(200);
    const lineage = images.body as {
      images: Array<{ sandboxName: string; upgradable: boolean }>;
      silent: unknown[];
    };
    expect(lineage.images.map((i) => i.sandboxName).sort()).toEqual([
      's1',
      's2',
      's3',
    ]);
    expect(lineage.images.every((i) => i.upgradable === false)).toBe(true);
    expect(lineage.silent).toEqual([]);
  });

  it('a host reading names its node: forwarded to it whole; unnamed in a fleet of several it is a 400 naming them; an unknown id is a 404', async () => {
    const h = await gateway(['b', 'c']);
    const named = await rpc(h, '/getHostMetrics', { nodeId: 'c' });
    expect(named.status).toBe(200);
    expect(named.body).toEqual({
      hostOf: 'c',
      verb: '/getHostMetrics',
      body: { nodeId: 'c' },
    });
    const history = await rpc(h, '/getHostMetricsHistory', {
      nodeId: 'b',
      start: '2026-09-14T00:00:00.000Z',
    });
    expect(history.body).toMatchObject({
      hostOf: 'b',
      verb: '/getHostMetricsHistory',
    });
    const unnamed = await rpc(h, '/getHostMetrics', {});
    expect(unnamed.status).toBe(400);
    expect(message(unnamed)).toContain('the fleet has 2 nodes (b, c)');
    expect(message(unnamed)).toContain('getFleetMetrics');
    const unknown = await rpc(h, '/getHostMetrics', { nodeId: 'zzz' });
    expect(unknown.status).toBe(404);
    expect(message(unknown)).toContain("no node with id 'zzz'");
    const malformed = await rpc(h, '/getHostMetrics', { nodeId: 7 });
    expect(malformed.status).toBe(400);
  });

  it('a fleet of one needs no name; a fleet of none is a 503 with Retry-After', async () => {
    const one = await gateway(['b']);
    const unnamed = await rpc(one, '/getHostMetrics', {});
    expect(unnamed.status).toBe(200);
    expect(unnamed.body).toMatchObject({ hostOf: 'b', body: {} });
    const none = await gateway([]);
    const refused = await rpc(none, '/getHostMetrics', {});
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('15');
    expect(message(refused)).toContain('no node has checked in yet');
  });

  it("the upgrade verbs are the gateway's own now, not a node's: no node is asked", async () => {
    const h = await gateway(['b']);
    const before = h.nodes[0]?.hits.length ?? 0;
    const s = await rpc(h, '/getUpgradeStatus', {});
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({
      available: false,
      nodes: [{ id: 'b', state: 'unknown' }],
    });
    expect(h.nodes[0]?.hits.length ?? 0).toBe(before);
  });
});

describe('the E2B list across nodes', () => {
  async function e2bList(h: Harness, query: string) {
    const res = await fetch(`${h.endpoint}/e2b/api/v2/sandboxes${query}`, {
      headers: { 'x-api-key': `e2b_${TOKEN}` },
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text ? (JSON.parse(text) as unknown) : null,
      next: res.headers.get('x-next-token'),
      retryAfter: res.headers.get('retry-after'),
    };
  }
  const ids = (r: { body: unknown }) =>
    (r.body as Array<{ sandboxID: string; alias: string }>).map((s) => s.alias);

  it('pages newest first across both nodes on one opaque cursor, and the last page carries no cursor', async () => {
    const h = await gateway(['b', 'c']);
    for (const name of ['e1', 'e2', 'e3']) {
      const created = await fetch(`${h.endpoint}/e2b/api/sandboxes`, {
        method: 'POST',
        headers: {
          'x-api-key': `e2b_${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ templateID: 'base', metadata: { name } }),
      });
      expect(created.status).toBe(201);
    }
    const [b, c] = h.nodes;
    if (!b || !c) throw new Error('nodes lost');
    expect(b.sandboxes.size + c.sandboxes.size).toBe(3);
    expect(Math.min(b.sandboxes.size, c.sandboxes.size)).toBeGreaterThan(0);

    const first = await e2bList(h, '?limit=2');
    expect(first.status).toBe(200);
    expect(ids(first)).toEqual(['e3', 'e2']);
    expect(first.next).not.toBeNull();
    const second = await e2bList(h, `?limit=2&nextToken=${first.next}`);
    expect(ids(second)).toEqual(['e1']);
    expect(second.next).toBeNull();

    // One at a time: three pages, every node asked its own offset.
    const seen: string[] = [];
    let token: string | null = null;
    do {
      const page = await e2bList(
        h,
        `?limit=1${token === null ? '' : `&nextToken=${token}`}`,
      );
      seen.push(...ids(page));
      token = page.next;
    } while (token !== null);
    expect(seen).toEqual(['e3', 'e2', 'e1']);

    const whole = await e2bList(h, '');
    expect(ids(whole)).toEqual(['e3', 'e2', 'e1']);
    expect(whole.next).toBeNull();
  });

  it('a cursor it did not mint is a 400; a node the list would lack is a 503 naming it, with Retry-After', async () => {
    const h = await gateway(['b', 'c']);
    const bad = await e2bList(h, '?nextToken=garbage');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({
      code: 400,
      message: expect.stringMatching(/invalid nextToken/),
    });
    const tooMany = await e2bList(h, '?limit=5000');
    expect(tooMany.status).toBe(400);
    const down = h.fleet.get('c');
    if (!down) throw new Error('node lost');
    down.lastCheckInAt = new Date(Date.now() - 31_000);
    const refused = await e2bList(h, '');
    expect(refused.status).toBe(503);
    expect(refused.retryAfter).toBe('15');
    expect(refused.body).toMatchObject({
      code: 503,
      message: expect.stringMatching(
        /node c did not answer \(has not checked in for 3\ds\)/,
      ),
    });
  });
});

describe('the request log', () => {
  it("says nothing of a 2xx; one line for a 4xx (info) or a 5xx (warn) naming method, path and status, the query left out; Fastify's own two lines per request are off", async () => {
    const logs: string[] = [];
    const h = await gateway(['b'], {}, { logs });
    // The harness's check-ins and a probe are 2xx: nothing said of them.
    expect((await fetch(`${h.endpoint}/healthz`)).status).toBe(200);
    const said = () =>
      logs
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.msg === 'request ended in an error status');
    expect(said()).toEqual([]);
    expect(
      logs.some(
        (l) =>
          l.includes('incoming request') || l.includes('request completed'),
      ),
    ).toBe(false);
    expect((await rpc(h, '/noSuchVerb?signature=secret-sig')).status).toBe(404);
    // Every node down: a new name is the placement's own 503, sent
    // directly, not through the error handler — logged all the same.
    const b = h.fleet.get('b');
    if (!b) throw new Error('node lost');
    b.lastCheckInAt = new Date(Date.now() - 31_000);
    expect((await rpc(h, '/acquireSandbox', { name: 'nowhere' })).status).toBe(
      503,
    );
    expect(said()).toEqual([
      expect.objectContaining({
        level: 30,
        method: 'POST',
        path: '/noSuchVerb',
        statusCode: 404,
      }),
      expect.objectContaining({
        level: 40,
        method: 'POST',
        path: '/acquireSandbox',
        statusCode: 503,
      }),
    ]);
    expect(logs.join('\n')).not.toContain('secret-sig');
  });
});
