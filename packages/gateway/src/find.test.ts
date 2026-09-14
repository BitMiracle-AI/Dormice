import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NameCache } from './cache';
import { migrateDb, openDb } from './db/db';
import { Finder } from './find';
import { Fleet } from './fleet';
import {
  type AskNode,
  httpAskNode,
  LOOKUP_TIMEOUT_MS,
  type LookupAnswer,
} from './lookup';
import { checkInOf } from './testing';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const TOKEN = 'shared-token-shared-token-shared-token';
const NOW = new Date('2026-09-14T12:00:00.000Z');

function fleetOf(...ids: string[]) {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const fleet = new Fleet(db);
  for (const id of ids) fleet.checkIn(checkInOf(id, `http://${id}:80`), NOW);
  return fleet;
}

const silentLog = { warn: () => {} };

/** An asker scripted per node: what each node says to any question, and how often it was asked. */
function scripted(script: Record<string, LookupAnswer>) {
  const asked: string[] = [];
  const ask: AskNode = async (node) => {
    asked.push(node.id);
    return script[node.id] ?? { kind: 'absent' };
  };
  return { ask, asked };
}

describe('Finder', () => {
  it('asks every node in parallel; exactly one yes wins and is cached by name and id', async () => {
    const fleet = fleetOf('a', 'b', 'c');
    const { ask, asked } = scripted({
      b: { kind: 'found', id: 'sb-1', name: 'alice', state: 'active' },
    });
    const cache = new NameCache();
    const finder = new Finder(fleet, cache, ask, silentLog);
    const found = await finder.byName('alice');
    expect(found).toMatchObject({ kind: 'one', id: 'sb-1', name: 'alice' });
    expect(found.kind === 'one' && found.node.id).toBe('b');
    expect(asked.sort()).toEqual(['a', 'b', 'c']);
    // The cache answers the next questions, by either handle, without a
    // single node asked.
    asked.length = 0;
    expect((await finder.byName('alice')).kind).toBe('one');
    expect((await finder.byId('sb-1')).kind).toBe('one');
    expect(asked).toEqual([]);
  });

  it('one yes wins even while another node is silent: the sandbox is where it says it is', async () => {
    const fleet = fleetOf('a', 'b');
    const { ask } = scripted({
      a: { kind: 'silent', why: 'ECONNREFUSED' },
      b: { kind: 'found', id: 'sb-1', name: 'alice', state: 'frozen' },
    });
    const found = await new Finder(
      fleet,
      new NameCache(),
      ask,
      silentLog,
    ).byName('alice');
    expect(found.kind === 'one' && found.node.id).toBe('b');
  });

  it('two yeses are a conflict naming both nodes, and nothing is cached', async () => {
    const fleet = fleetOf('a', 'b', 'c');
    const { ask } = scripted({
      c: { kind: 'found', id: 'sb-2', name: 'alice', state: 'active' },
      a: { kind: 'found', id: 'sb-1', name: 'alice', state: 'active' },
    });
    const cache = new NameCache();
    const found = await new Finder(fleet, cache, ask, silentLog).byName(
      'alice',
    );
    expect(found).toEqual({
      kind: 'conflict',
      nodes: [
        { id: 'a', endpoint: 'http://a:80' },
        { id: 'c', endpoint: 'http://c:80' },
      ],
    });
    expect(cache.size).toBe(0);
  });

  it('two ids checked in from one endpoint answer twice for every name there: a conflict whose nodes share the endpoint', async () => {
    const fleet = fleetOf('a', 'b');
    // The node at a's address checks in again under a new id: a rename.
    fleet.checkIn(checkInOf('a-renamed', 'http://a:80'), NOW);
    const { ask } = scripted({
      a: { kind: 'found', id: 'sb-1', name: 'alice', state: 'active' },
      'a-renamed': {
        kind: 'found',
        id: 'sb-1',
        name: 'alice',
        state: 'active',
      },
    });
    const found = await new Finder(
      fleet,
      new NameCache(),
      ask,
      silentLog,
    ).byName('alice');
    expect(found).toEqual({
      kind: 'conflict',
      nodes: [
        { id: 'a', endpoint: 'http://a:80' },
        { id: 'a-renamed', endpoint: 'http://a:80' },
      ],
    });
  });

  it('every node says no: the name is new; a silent node among the noes: unsure, naming it', async () => {
    const fleet = fleetOf('a', 'b');
    expect(
      await new Finder(
        fleet,
        new NameCache(),
        scripted({}).ask,
        silentLog,
      ).byName('nobody'),
    ).toEqual({ kind: 'none' });
    const warned: unknown[] = [];
    const unsure = await new Finder(
      fleet,
      new NameCache(),
      scripted({ b: { kind: 'silent', why: 'timeout' } }).ask,
      { warn: (obj) => warned.push(obj) },
    ).byName('nobody');
    expect(unsure).toEqual({
      kind: 'unsure',
      silent: [{ nodeId: 'b', why: 'timeout' }],
    });
    expect(warned).toHaveLength(1);
  });

  it('an empty fleet finds nothing and asks nobody', async () => {
    const { ask, asked } = scripted({});
    expect(
      await new Finder(fleetOf(), new NameCache(), ask, silentLog).byName('x'),
    ).toEqual({ kind: 'none' });
    expect(asked).toEqual([]);
  });

  it('a cached entry whose node was removed is dropped and the fleet asked afresh', async () => {
    const fleet = fleetOf('a', 'b');
    const { ask, asked } = scripted({
      a: { kind: 'found', id: 'sb-1', name: 'alice', state: 'active' },
    });
    const cache = new NameCache();
    const finder = new Finder(fleet, cache, ask, silentLog);
    await finder.byName('alice');
    fleet.remove('a');
    asked.length = 0;
    expect(await finder.byName('alice')).toEqual({ kind: 'none' });
    expect(asked).toEqual(['b']);
    expect(cache.size).toBe(0);
  });

  it('verify: a node that says absent loses the entry; a silent node keeps it; a removed node loses it', async () => {
    const fleet = fleetOf('a', 'b');
    const script: Record<string, LookupAnswer> = {
      a: { kind: 'found', id: 'sb-1', name: 'alice', state: 'active' },
    };
    const cache = new NameCache();
    const finder = new Finder(
      fleet,
      cache,
      async (node) => script[node.id] ?? { kind: 'absent' },
      silentLog,
    );
    await finder.byName('alice');
    const entry = { id: 'sb-1', name: 'alice', nodeId: 'a' };
    script.a = { kind: 'silent', why: 'timeout' };
    await finder.verify(entry);
    expect(cache.getByName('alice')).toEqual(entry);
    script.a = { kind: 'absent' };
    await finder.verify(entry);
    expect(cache.getByName('alice')).toBeUndefined();
    expect(cache.getById('sb-1')).toBeUndefined();

    cache.put(entry);
    fleet.remove('a');
    await finder.verify(entry);
    expect(cache.size).toBe(0);
  });
});

describe('NameCache', () => {
  it('a name that moved to a new id drops the old id; an id that gained a name is reachable by both', () => {
    const cache = new NameCache();
    cache.put({ id: 'old', name: 'alice', nodeId: 'a' });
    cache.put({ id: 'new', name: 'alice', nodeId: 'b' });
    expect(cache.getById('old')).toBeUndefined();
    expect(cache.getByName('alice')?.nodeId).toBe('b');
    cache.put({ id: 'anon', name: null, nodeId: 'a' });
    cache.put({ id: 'anon', name: 'e2b-1', nodeId: 'a' });
    expect(cache.getByName('e2b-1')?.id).toBe('anon');
    expect(cache.size).toBe(2);
    expect(cache.evictNode('a')).toBe(1);
    expect(cache.getById('anon')).toBeUndefined();
    expect(cache.size).toBe(1);
  });
});

describe('httpAskNode', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
  });

  async function node(
    handler: (
      body: unknown,
      headers: http.IncomingHttpHeaders,
    ) => { status: number; body: string },
  ) {
    const server = http.createServer((req, res) => {
      let text = '';
      req.on('data', (c) => {
        text += c;
      });
      req.on('end', () => {
        const answer = handler(JSON.parse(text), req.headers);
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(answer.body);
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return {
      id: 'n',
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    };
  }

  it('posts the question under the fleet token and reads found / absent; a non-200 or a refused connection is silent with the reason', async () => {
    const seen: unknown[] = [];
    const yes = await node((body, headers) => {
      seen.push({ body, auth: headers.authorization });
      return {
        status: 200,
        body: JSON.stringify({
          found: true,
          sandbox: { id: 'sb-1', name: 'alice', state: 'active' },
        }),
      };
    });
    const ask = httpAskNode(TOKEN);
    expect(await ask(yes, { name: 'alice' })).toEqual({
      kind: 'found',
      id: 'sb-1',
      name: 'alice',
      state: 'active',
    });
    expect(seen).toEqual([
      { body: { name: 'alice' }, auth: `Bearer ${TOKEN}` },
    ]);
    const no = await node(() => ({
      status: 200,
      body: JSON.stringify({ found: false }),
    }));
    expect(await ask(no, { id: 'x' })).toEqual({ kind: 'absent' });
    const refusing = await node(() => ({
      status: 401,
      body: '{"message":"missing or invalid API token"}',
    }));
    expect(await ask(refusing, { id: 'x' })).toMatchObject({
      kind: 'silent',
      why: expect.stringMatching(/answered 401/),
    });
    // A port nobody listens on any more: the OS hands one out and it is
    // released before the question is asked. (Not port 9 — fetch refuses
    // the Fetch standard's "bad ports" without dialling.)
    const released = http.createServer();
    await new Promise<void>((r) => released.listen(0, '127.0.0.1', r));
    const port = (released.address() as AddressInfo).port;
    await new Promise<void>((r) => released.close(() => r()));
    expect(
      await ask(
        { id: 'gone', endpoint: `http://127.0.0.1:${port}` },
        { id: 'x' },
      ),
    ).toMatchObject({ kind: 'silent', why: 'ECONNREFUSED' });
  });

  it('a node whose host swallows the connection is silent after the two seconds, not after a connect timeout — and the why is a word, not a number', async () => {
    // 192.0.2.1 (TEST-NET-1) is routed nowhere: the SYN is dropped, the
    // connect hangs. Where a network refuses it outright instead
    // (ENETUNREACH), the answer is immediate and the assertion still holds.
    const started = Date.now();
    const answer = await httpAskNode(TOKEN)(
      { id: 'hole', endpoint: 'http://192.0.2.1:80' },
      { id: 'x' },
    );
    expect(Date.now() - started).toBeLessThan(LOOKUP_TIMEOUT_MS + 1_500);
    expect(answer.kind).toBe('silent');
    expect(answer.kind === 'silent' && typeof answer.why).toBe('string');
    expect(answer.kind === 'silent' && answer.why).not.toMatch(/^\d+$/);
  }, 15_000);
});
