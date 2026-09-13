import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { KeyedQueue } from '@dormice/server/keyed-queue';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGatewayApp } from './app';
import { NameCache } from './cache';
import { loadConfig } from './config';
import { migrateDb, openDb } from './db/db';
import { Finder } from './find';
import { Fleet } from './fleet';
import { httpAskNode } from './lookup';
import { checkInOf, type reading } from './testing';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const TOKEN = 'fleet-token-fleet-token-fleet-token-fleet';

/**
 * A node as the gateway sees one: the daemon's wire for the handful of
 * verbs the gateway touches, over a real socket. Every sandbox it holds is
 * a row in `sandboxes`; every request it received is in `hits`.
 */
class FakeNode {
  readonly sandboxes = new Map<
    string,
    { id: string; name: string; files: Map<string, string> }
  >();
  readonly hits: Array<{ path: string; auth: string | undefined }> = [];
  creates = 0;
  endpoint = '';
  private readonly server: http.Server;

  constructor(readonly id: string) {
    this.server = http.createServer((req, res) => {
      let text = '';
      req.on('data', (c) => {
        text += c;
      });
      req.on('end', () => this.answer(req, res, text));
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
    this.hits.push({ path, auth });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
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
      case '/lookupSandbox': {
        const sandbox = 'id' in body ? this.byId(body.id as string) : found;
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
        if (name !== undefined) this.sandboxes.delete(name);
        return json(200, { destroyed: found !== undefined });
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
    const sandbox = { id: randomUUID(), name, files: new Map() };
    this.sandboxes.set(name, sandbox);
    return sandbox;
  }
}

interface Harness {
  endpoint: string;
  nodes: FakeNode[];
  cache: NameCache;
  fleet: Fleet;
  checkIn(
    node: FakeNode,
    over?: Parameters<typeof reading>[0] & { intervalSeconds?: number },
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
  const fleet = new Fleet(db);
  const cache = new NameCache();
  const finder = new Finder(fleet, cache, httpAskNode(TOKEN), {
    warn: () => {},
  });
  const app = buildGatewayApp({
    config,
    fleet,
    finder,
    locks: new KeyedQueue(),
    logger: false,
    build: null,
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
    await h.checkIn(moved, { active: 3 });
    expect(h.fleet.get('b')?.endpoint).toBe(moved.endpoint);
    expect(h.fleet.get('b')?.reading?.sandboxes.byState.active).toBe(3);
    await moved.stop();
    // A malformed check-in is a 400 naming the trouble, not a join.
    const bad = await rpc(h, '/checkIn', { nodeId: 'z' });
    expect(bad.status).toBe(400);
    expect(h.fleet.get('z')).toBeUndefined();
  });

  it('removeNode forgets the node and everything cached on it; a removed node that checks in again re-joins', async () => {
    const h = await gateway(['b', 'c']);
    const created = sandboxOf(await rpc(h, '/acquireSandbox', { name: 'x' }));
    expect(h.cache.getByName('x')?.nodeId).toBe(created.nodeId);
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
});

describe('acquire: placing and finding', () => {
  it('a new name lands on the emptiest node by active density, under the fleet token, and is cached: the second acquire asks nobody', async () => {
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
    expect(a.lookups()).toBe(1);
    expect(b.lookups()).toBe(1);
    expect(h.fleet.get('b')?.placedSinceCheckIn).toBe(1);
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

  it('daemon-addressed verbs are an honest 501, a misspelled verb a 404, a body without a name a 400', async () => {
    const h = await gateway(['a']);
    const listed = await rpc(h, '/listSandboxes');
    expect(listed.status).toBe(501);
    expect(message(listed)).toContain('call the node directly');
    expect((await rpc(h, '/createApiKey', { name: 'k' })).status).toBe(501);
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

    expect((await e2b(h, '/v2/sandboxes')).status).toBe(501);
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
    const bare = await fetch(`${h.endpoint}/files?signature=x`);
    expect(bare.status).toBe(501);
    expect(bare.headers.get('access-control-allow-origin')).toBe('*');
    expect(((await bare.json()) as { code: string }).code).toBe(
      'unimplemented',
    );
  });
});
