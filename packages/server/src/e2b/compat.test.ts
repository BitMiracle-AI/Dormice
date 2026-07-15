import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { Archiver } from '../archive/archiver';
import { MemStore } from '../archive/mem-store';
import { objectKey } from '../archive/store';
import { loadConfig } from '../config';
import { migrateDb, openDb } from '../db/db';
import { findBySandboxId, setDeadline } from '../db/ledger';
import { getOrCreateSigningSecret } from '../db/secrets';
import { FAKE_BASE_IMAGE, FakeExecutor } from '../executor/fake';
import { KeyedQueue } from '../keyed-queue';
import { sampleOnce } from '../metrics-sampler';
import { scanOnce } from '../scanner';
import { mintEnvdToken } from './protocol';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const TOKEN = 'test-token-test-token-test-token';

function testApp(
  executor: FakeExecutor = new FakeExecutor(),
  env: Record<string, string> = {},
) {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const config = loadConfig({
    DORMICE_DB_PATH: ':memory:',
    DORMICE_NODE_ID: 'node-test',
    DORMICE_API_TOKEN: TOKEN,
    ...env,
  });
  const locks = new KeyedQueue();
  const app = buildApp({ config, db, executor, locks, logger: false });
  return { app, db, executor, locks };
}

type TestApp = ReturnType<typeof testApp>;

const apiKey = { 'x-api-key': `e2b_${TOKEN}` };

function control(
  t: TestApp,
  method: 'POST' | 'GET' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) {
  return t.app.inject({
    method,
    url: `/e2b/api${url}`,
    headers: apiKey,
    ...(payload === undefined ? {} : { payload }),
  });
}

async function createSandbox(
  t: TestApp,
  payload: Record<string, unknown> = {},
): Promise<{ sandboxID: string; envdAccessToken: string }> {
  const res = await control(t, 'POST', '/sandboxes', payload);
  expect(res.statusCode).toBe(201);
  return res.json();
}

// The envd token derives from the app's ledger-stored signing secret, not
// the API token — get-or-create returns the one buildApp already minted.
function envdHeaders(t: TestApp, sandboxID: string) {
  return {
    'e2b-sandbox-id': sandboxID,
    'x-access-token': mintEnvdToken(getOrCreateSigningSecret(t.db), sandboxID),
  };
}

function envdRpc(
  t: TestApp,
  sandboxID: string,
  url: string,
  payload: Record<string, unknown>,
) {
  return t.app.inject({
    method: 'POST',
    url: `/e2b/envd${url}`,
    headers: envdHeaders(t, sandboxID),
    payload,
  });
}

/** 1 flag byte + 4-byte BE length + JSON, repeated — the Connect stream shape. */
function parseEnvelopes(
  payload: Buffer,
): Array<{ flags: number; json: Record<string, unknown> }> {
  const frames: Array<{ flags: number; json: Record<string, unknown> }> = [];
  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload.readUInt8(offset);
    const length = payload.readUInt32BE(offset + 1);
    const body = payload.subarray(offset + 5, offset + 5 + length);
    frames.push({
      flags,
      json: body.length > 0 ? JSON.parse(body.toString('utf8')) : {},
    });
    offset += 5 + length;
  }
  return frames;
}

/** One enveloped Connect request frame — what a streaming RPC's body looks like. */
function enveloped(message: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(5);
  head.writeUInt8(0, 0);
  head.writeUInt32BE(json.length, 1);
  return Buffer.concat([head, json]);
}

function startCommand(
  t: TestApp,
  sandboxID: string,
  command: string,
  opts: {
    envs?: Record<string, string>;
    headers?: Record<string, string>;
    stdin?: boolean;
  } = {},
) {
  const message = {
    process: {
      cmd: '/bin/bash',
      args: ['-l', '-c', command],
      envs: opts.envs ?? {},
    },
    ...(opts.stdin ? { stdin: true } : {}),
  };
  return t.app.inject({
    method: 'POST',
    url: '/e2b/envd/process.Process/Start',
    headers: {
      ...envdHeaders(t, sandboxID),
      'content-type': 'application/connect+json',
      ...opts.headers,
    },
    payload: enveloped(message),
  });
}

/** What pty.create sends: bash -i -l plus a pty block, no -c command. */
function startPty(t: TestApp, sandboxID: string) {
  return t.app.inject({
    method: 'POST',
    url: '/e2b/envd/process.Process/Start',
    headers: {
      ...envdHeaders(t, sandboxID),
      'content-type': 'application/connect+json',
    },
    payload: enveloped({
      process: {
        cmd: '/bin/bash',
        args: ['-i', '-l'],
        envs: { TERM: 'xterm-256color' },
      },
      pty: { size: { cols: 80, rows: 24 } },
    }),
  });
}

function connectProcess(t: TestApp, sandboxID: string, pid: number) {
  return t.app.inject({
    method: 'POST',
    url: '/e2b/envd/process.Process/Connect',
    headers: {
      ...envdHeaders(t, sandboxID),
      'content-type': 'application/connect+json',
    },
    payload: enveloped({ process: { pid } }),
  });
}

/** Polls List until the sandbox shows a live process — Start's response is still in flight. */
async function waitForPid(t: TestApp, sandboxID: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const res = await envdRpc(t, sandboxID, '/process.Process/List', {});
    const procs = res.json().processes as Array<{ pid: number }>;
    if (procs.length > 0 && procs[0]) return procs[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('process never appeared in List');
}

describe('E2B control plane', () => {
  it('guards with X-API-KEY: e2b_-prefixed and bare tokens pass, others do not', async () => {
    const t = testApp();
    const denied = await t.app.inject({
      method: 'POST',
      url: '/e2b/api/sandboxes',
      headers: { 'x-api-key': 'e2b_wrong' },
      payload: {},
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({ code: 401, message: 'invalid API key' });

    const bare = await t.app.inject({
      method: 'POST',
      url: '/e2b/api/sandboxes',
      headers: { 'x-api-key': TOKEN },
      payload: {},
    });
    expect(bare.statusCode).toBe(201);
  });

  it('creates a fresh sandbox per call — E2B semantics, no key given', async () => {
    const t = testApp();
    const first = await createSandbox(t);
    const second = await createSandbox(t);
    expect(first.sandboxID).not.toBe(second.sandboxID);
    // Minted from the ledger's signing secret — deliberately NOT something
    // the API token can recompute.
    expect(first.envdAccessToken).toBe(
      mintEnvdToken(getOrCreateSigningSecret(t.db), first.sandboxID),
    );
    expect(t.executor.stateOf(first.sandboxID)).toBe('running');
  });

  it('metadata.externalId is the Dormice extension: same key, same sandbox', async () => {
    const t = testApp();
    const first = await createSandbox(t, {
      metadata: { externalId: 'agent-7' },
    });
    const second = await createSandbox(t, {
      metadata: { externalId: 'agent-7' },
    });
    expect(second.sandboxID).toBe(first.sandboxID);
  });

  it('getInfo echoes metadata and reports the deadline as endAt', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t, {
      timeout: 600,
      metadata: { externalId: 'meta-echo', team: 'blue' },
    });
    const res = await control(t, 'GET', `/sandboxes/${sandboxID}`);
    expect(res.statusCode).toBe(200);
    const info = res.json();
    expect(info.state).toBe('running');
    expect(info.metadata).toEqual({ externalId: 'meta-echo', team: 'blue' });
    const endInMs = Date.parse(info.endAt) - Date.now();
    expect(endInMs).toBeGreaterThan(590_000);
    expect(endInMs).toBeLessThan(610_000);
  });

  it('info views carry every field the Python SDK hard-requires', async () => {
    // The JS SDK tolerates missing fields; the Python SDK's generated
    // models KeyError on them before user code runs (measured 2026-07-10:
    // absent clientID/diskSizeMB killed its whole suite at create). This
    // pins the full required set in the CI-run suite.
    const t = testApp();
    const create = await control(t, 'POST', '/sandboxes', {
      templateID: 'base',
    });
    expect(create.statusCode).toBe(201);
    const session = create.json();
    expect(session.clientID).toBe('node-test');
    expect(session.sandboxID).toBeDefined();
    expect(session.templateID).toBeDefined();
    expect(session.envdVersion).toBeDefined();

    const info = (
      await control(t, 'GET', `/sandboxes/${session.sandboxID}`)
    ).json();
    for (const field of [
      'clientID',
      'cpuCount',
      'diskSizeMB',
      'endAt',
      'envdVersion',
      'memoryMB',
      'sandboxID',
      'startedAt',
      'state',
      'templateID',
    ]) {
      expect(info[field], `info.${field}`).toBeDefined();
    }
    expect(info.diskSizeMB).toBe(10 * 1024);

    const listed = (await control(t, 'GET', '/v2/sandboxes')).json();
    expect(listed[0].clientID).toBe('node-test');
    expect(listed[0].diskSizeMB).toBe(10 * 1024);
  });

  it('kill destroys for real: container, disk, row — and 404s after', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const killed = await control(t, 'DELETE', `/sandboxes/${sandboxID}`);
    expect(killed.statusCode).toBe(204);
    expect(t.executor.stateOf(sandboxID)).toBeUndefined();
    expect(await t.executor.listDisks()).not.toContain(sandboxID);
    expect(findBySandboxId(t.db, sandboxID)).toBeUndefined();

    const again = await control(t, 'DELETE', `/sandboxes/${sandboxID}`);
    expect(again.statusCode).toBe(404);
    // The SDK's kill() keys "already gone -> false" off this numeric code.
    expect(again.json().code).toBe(404);
  });

  it('an expired kill-deadline is protocol-dead immediately, reaped by the scanner after', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t, { timeout: 300 });
    const row = findBySandboxId(t.db, sandboxID);
    expect(row?.onDeadline).toBe('kill');
    // Time-travel the deadline into the past instead of sleeping.
    setDeadline(t.db, sandboxID, {
      deadlineAt: new Date(Date.now() - 1000).toISOString(),
      onDeadline: 'kill',
    });

    // The view answers dead before any physical teardown happened.
    expect(
      (await control(t, 'GET', `/sandboxes/${sandboxID}`)).statusCode,
    ).toBe(404);
    const connect = await control(
      t,
      'POST',
      `/sandboxes/${sandboxID}/connect`,
      {
        timeout: 300,
      },
    );
    expect(connect.statusCode).toBe(404);

    // The scanner's sweep makes it physical.
    const result = await scanOnce(t.db, t.executor, t.locks, new Date());
    expect(result.expiredKilled).toBe(1);
    expect(t.executor.stateOf(sandboxID)).toBeUndefined();
  });

  it('autoPause parks at the deadline and connect revives with a fresh TTL', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t, {
      timeout: 300,
      autoPause: true,
    });
    setDeadline(t.db, sandboxID, {
      deadlineAt: new Date(Date.now() - 1000).toISOString(),
      onDeadline: 'pause',
    });

    const paused = await control(t, 'GET', `/sandboxes/${sandboxID}`);
    expect(paused.json().state).toBe('paused');

    const connect = await control(
      t,
      'POST',
      `/sandboxes/${sandboxID}/connect`,
      {
        timeout: 300,
      },
    );
    expect(connect.statusCode).toBe(201); // 201 = this connect resumed it

    const info = await control(t, 'GET', `/sandboxes/${sandboxID}`);
    expect(info.json().state).toBe('running');
    const fresh = findBySandboxId(t.db, sandboxID);
    expect(Date.parse(fresh?.deadlineAt ?? '')).toBeGreaterThan(Date.now());
  });

  it('pause parks (frozen), reports paused, 409s a second pause, connect resumes', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const paused = await control(
      t,
      'POST',
      `/sandboxes/${sandboxID}/pause`,
      {},
    );
    expect(paused.statusCode).toBe(204);
    expect(t.executor.stateOf(sandboxID)).toBe('paused');
    expect(
      (await control(t, 'GET', `/sandboxes/${sandboxID}`)).json().state,
    ).toBe('paused');

    const again = await control(t, 'POST', `/sandboxes/${sandboxID}/pause`, {});
    expect(again.statusCode).toBe(409);

    const connect = await control(
      t,
      'POST',
      `/sandboxes/${sandboxID}/connect`,
      {
        timeout: 300,
      },
    );
    expect(connect.statusCode).toBe(201);
    expect(t.executor.stateOf(sandboxID)).toBe('running');
  });

  it('pause with memory:false maps to stopped — filesystem only, cold boot on resume', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const res = await control(t, 'POST', `/sandboxes/${sandboxID}/pause`, {
      memory: false,
    });
    expect(res.statusCode).toBe(204);
    expect(t.executor.stateOf(sandboxID)).toBe('stopped');
    expect(findBySandboxId(t.db, sandboxID)?.state).toBe('stopped');
  });

  it('metrics with no history takes one live reading, SDK field names', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    // The sampler never ticked: the window is empty, the sandbox measurable
    // and the default window reaches "now" — the compatibility fallback
    // answers one live sample (real E2B has data seconds after create; an
    // empty array would read as breakage).
    const res = await control(t, 'GET', `/sandboxes/${sandboxID}/metrics`);
    expect(res.statusCode).toBe(200);
    const samples = res.json();
    expect(samples).toHaveLength(1);
    const m = samples[0];
    expect(Date.parse(m.timestamp)).not.toBeNaN();
    expect(
      Math.abs(Date.parse(m.timestamp) / 1000 - m.timestampUnix),
    ).toBeLessThanOrEqual(1);
    expect(m.cpuCount).toBeGreaterThanOrEqual(1);
    expect(m.cpuUsedPct).toBeGreaterThanOrEqual(0);
    expect(m.memUsed).toBeGreaterThan(0);
    expect(m.memTotal).toBeGreaterThan(0);
    expect(m.memCache).toBeGreaterThanOrEqual(0);
    expect(m.diskUsed).toBeGreaterThan(0);
    expect(m.diskTotal).toBeGreaterThan(0);
  });

  it('metrics slices the sampled history by start/end (unix seconds)', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    // Three sampler ticks 30s apart, in the recent past.
    const t0 = Date.now() - 120_000;
    for (let i = 0; i < 3; i += 1) {
      await sampleOnce(t.db, t.executor, new Date(t0 + i * 30_000), {
        retentionHours: 168,
      });
    }
    // A window around the middle tick: exactly that sample, ISO and unix
    // spellings agreeing.
    const start = Math.floor((t0 + 15_000) / 1000);
    const end = Math.floor((t0 + 45_000) / 1000);
    const res = await control(
      t,
      'GET',
      `/sandboxes/${sandboxID}/metrics?start=${start}&end=${end}`,
    );
    expect(res.statusCode).toBe(200);
    const samples = res.json();
    expect(samples).toHaveLength(1);
    expect(samples[0].timestamp).toBe(new Date(t0 + 30_000).toISOString());
    expect(samples[0].timestampUnix).toBe(Math.floor((t0 + 30_000) / 1000));

    // An explicitly past window with no rows answers [] — the live fallback
    // never fills a window that does not reach "now" (a reading taken now
    // would land outside it, a lie).
    const past = await control(
      t,
      'GET',
      `/sandboxes/${sandboxID}/metrics?start=1&end=2`,
    );
    expect(past.statusCode).toBe(200);
    expect(past.json()).toEqual([]);

    // Seconds beyond what a JS Date can represent are rejected at the door
    // as a 400 — never a RangeError-turned-500 deep in the handler.
    const absurd = await control(
      t,
      'GET',
      `/sandboxes/${sandboxID}/metrics?start=9000000000000`,
    );
    expect(absurd.statusCode).toBe(400);
  });

  it('metrics reads a frozen sandbox without waking it; a stopped one answers []', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t, { timeout: 86400 });
    // Freeze through the idle scanner, exactly like production.
    const row = findBySandboxId(t.db, sandboxID);
    const later = new Date(
      Date.now() + ((row?.freezeAfterSeconds ?? 0) + 60) * 1000,
    );
    await scanOnce(t.db, t.executor, t.locks, later);
    expect(t.executor.stateOf(sandboxID)).toBe('paused');

    // No history: the fallback measures the paused container as it sleeps.
    const frozen = await control(t, 'GET', `/sandboxes/${sandboxID}/metrics`);
    expect(frozen.statusCode).toBe(200);
    expect(frozen.json()).toHaveLength(1);
    // Observation is not activity: still paused afterwards.
    expect(t.executor.stateOf(sandboxID)).toBe('paused');

    // keepMemory:false parks it stopped — nothing runs, no history was
    // sampled, and the fallback refuses to measure a dead container.
    await control(t, 'POST', `/sandboxes/${sandboxID}/pause`, {
      memory: false,
    });
    const stopped = await control(t, 'GET', `/sandboxes/${sandboxID}/metrics`);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toEqual([]);
  });

  it('metrics 404s an unknown sandbox in the control-plane dialect', async () => {
    const t = testApp();
    const res = await control(t, 'GET', '/sandboxes/no-such/metrics');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      code: 404,
      message: 'sandbox "no-such" not found',
    });
  });

  it('lists with metadata and state filters, paginating via x-next-token', async () => {
    const t = testApp();
    const blue1 = await createSandbox(t, { metadata: { team: 'blue' } });
    const blue2 = await createSandbox(t, { metadata: { team: 'blue' } });
    await createSandbox(t, { metadata: { team: 'red' } });

    const blues = await control(t, 'GET', '/v2/sandboxes?metadata=team%3Dblue');
    expect(blues.statusCode).toBe(200);
    expect(
      blues
        .json()
        .map((s: { sandboxID: string }) => s.sandboxID)
        .sort(),
    ).toEqual([blue1.sandboxID, blue2.sandboxID].sort());

    await control(t, 'POST', `/sandboxes/${blue1.sandboxID}/pause`, {});
    const pausedOnly = await control(t, 'GET', '/v2/sandboxes?state=paused');
    expect(
      pausedOnly.json().map((s: { sandboxID: string }) => s.sandboxID),
    ).toEqual([blue1.sandboxID]);

    const pageOne = await control(t, 'GET', '/v2/sandboxes?limit=2');
    expect(pageOne.json()).toHaveLength(2);
    const token = pageOne.headers['x-next-token'];
    expect(token).toBe('2');
    const pageTwo = await control(
      t,
      'GET',
      `/v2/sandboxes?limit=2&nextToken=${token}`,
    );
    expect(pageTwo.json()).toHaveLength(1);
    expect(pageTwo.headers['x-next-token']).toBeUndefined();
  });

  it('carries no domain field when the sandbox domain is not configured', async () => {
    // getHost's raw material must be honestly absent, not guessed at — the
    // SDK would otherwise build hosts that resolve nowhere. The configured
    // side is pinned by sandbox-proxy.test.ts over a real socket.
    const t = testApp();
    const created = await control(t, 'POST', '/sandboxes', {});
    expect(created.json()).not.toHaveProperty('domain');
    const info = await control(
      t,
      'GET',
      `/sandboxes/${created.json().sandboxID}`,
    );
    expect(info.json()).not.toHaveProperty('domain');
  });

  it('never imposes a deadline on a natively-acquired sandbox', async () => {
    const t = testApp();
    const native = await t.app.inject({
      method: 'POST',
      url: '/acquireSandbox',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { externalId: 'native-immortal' },
    });
    const sandboxId = native.json().sandbox.sandboxId;

    const res = await control(t, 'POST', `/sandboxes/${sandboxId}/timeout`, {
      timeout: 60,
    });
    expect(res.statusCode).toBe(204);
    // Accepted but not applied: immortality is the owner's choice.
    expect(findBySandboxId(t.db, sandboxId)?.deadlineAt).toBeNull();
  });
});

describe('E2B envd surface', () => {
  it('health probes the logical state: running 204, paused 502, unknown 502', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const probe = (id: string) =>
      t.app.inject({
        method: 'GET',
        url: '/e2b/envd/health',
        headers: { 'e2b-sandbox-id': id },
      });

    expect((await probe(sandboxID)).statusCode).toBe(204);
    await control(t, 'POST', `/sandboxes/${sandboxID}/pause`, {});
    expect((await probe(sandboxID)).statusCode).toBe(502);
    expect((await probe('no-such-sandbox')).statusCode).toBe(502);
  });

  it('rejects a wrong or missing envd access token', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const res = await t.app.inject({
      method: 'POST',
      url: '/e2b/envd/filesystem.Filesystem/Stat',
      headers: { 'e2b-sandbox-id': sandboxID, 'x-access-token': 'wrong' },
      payload: { path: '/home/user' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthenticated');
  });

  it('a token derived from the API token no longer opens the envd door', async () => {
    // The decoupling pin: envd tokens derive from the ledger's signing
    // secret. If someone re-couples them to the API token, this goes red.
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const res = await t.app.inject({
      method: 'POST',
      url: '/e2b/envd/filesystem.Filesystem/Stat',
      headers: {
        'e2b-sandbox-id': sandboxID,
        'x-access-token': mintEnvdToken(TOKEN, sandboxID),
      },
      payload: { path: '/home/user' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('files round-trip over plain HTTP: multipart up, raw bytes down, content-length exact', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const content = 'streamed through multipart\n';
    const boundary = 'dormice-test-boundary';
    const body = [
      `--${boundary}`,
      // A nested filename on purpose: busboy's default strips directories
      // (preservePath pins the fix — a bare basename would pass by luck).
      'Content-Disposition: form-data; name="file"; filename="/home/user/nested/up.txt"',
      'Content-Type: application/octet-stream',
      '',
      content,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const up = await t.app.inject({
      method: 'POST',
      url: '/e2b/envd/files?username=user',
      headers: {
        ...envdHeaders(t, sandboxID),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toEqual([
      { name: 'up.txt', type: 'file', path: '/home/user/nested/up.txt' },
    ]);

    const down = await t.app.inject({
      method: 'GET',
      url: '/e2b/envd/files?path=/home/user/nested/up.txt&username=user',
      headers: envdHeaders(t, sandboxID),
    });
    expect(down.statusCode).toBe(200);
    expect(down.headers['content-length']).toBe(String(content.length));
    expect(down.body).toBe(content);

    const missing = await t.app.inject({
      method: 'GET',
      url: '/e2b/envd/files?path=/home/user/void.txt',
      headers: envdHeaders(t, sandboxID),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('not_found');
  });

  it('accepts octet-stream uploads with the path in the query', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const res = await t.app.inject({
      method: 'POST',
      url: '/e2b/envd/files?path=raw.bin&username=user',
      headers: {
        ...envdHeaders(t, sandboxID),
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from([1, 2, 3, 250]),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { name: 'raw.bin', type: 'file', path: '/home/user/raw.bin' },
    ]);
  });

  it('decodes a gzip content-encoding on octet-stream uploads', async () => {
    // The SDK's write(gzip=true) compresses the whole body; storing the
    // gzip framing would deliver a corrupted file (measured 2026-07-10
    // under the Python SDK, the option's main user).
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const plain = 'compressible '.repeat(64);
    const res = await t.app.inject({
      method: 'POST',
      url: '/e2b/envd/files?path=zipped.txt&username=user',
      headers: {
        ...envdHeaders(t, sandboxID),
        'content-type': 'application/octet-stream',
        'content-encoding': 'gzip',
      },
      payload: gzipSync(Buffer.from(plain)),
    });
    expect(res.statusCode).toBe(200);

    const down = await t.app.inject({
      method: 'GET',
      url: '/e2b/envd/files?path=zipped.txt&username=user',
      headers: envdHeaders(t, sandboxID),
    });
    expect(down.body).toBe(plain);
  });

  it('speaks the filesystem service: Stat, ListDir, MakeDir, Move, Remove', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    await envdRpc(t, sandboxID, '/filesystem.Filesystem/MakeDir', {
      path: '/home/user/dir',
    });
    // MakeDir again: already_exists — the SDK reads it as false.
    const dup = await envdRpc(t, sandboxID, '/filesystem.Filesystem/MakeDir', {
      path: '/home/user/dir',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('already_exists');

    await t.app.inject({
      method: 'POST',
      url: '/e2b/envd/files?path=/home/user/dir/f.txt',
      headers: {
        ...envdHeaders(t, sandboxID),
        'content-type': 'application/octet-stream',
      },
      payload: 'content!',
    });

    const stat = await envdRpc(t, sandboxID, '/filesystem.Filesystem/Stat', {
      path: '/home/user/dir/f.txt',
    });
    expect(stat.statusCode).toBe(200);
    expect(stat.json().entry).toMatchObject({
      name: 'f.txt',
      type: 'FILE_TYPE_FILE',
      path: '/home/user/dir/f.txt',
      size: '8', // proto int64 travels as a string
      permissions: '-rw-r--r--',
      owner: 'user',
    });

    const list = await envdRpc(t, sandboxID, '/filesystem.Filesystem/ListDir', {
      path: '/home/user/dir',
      depth: 1,
    });
    expect(list.json().entries.map((e: { path: string }) => e.path)).toEqual([
      '/home/user/dir/f.txt',
    ]);

    const moved = await envdRpc(t, sandboxID, '/filesystem.Filesystem/Move', {
      source: '/home/user/dir/f.txt',
      destination: '/home/user/dir/g.txt',
    });
    expect(moved.json().entry.path).toBe('/home/user/dir/g.txt');

    const removed = await envdRpc(
      t,
      sandboxID,
      '/filesystem.Filesystem/Remove',
      {
        path: '/home/user/dir',
      },
    );
    expect(removed.statusCode).toBe(200);
    const gone = await envdRpc(t, sandboxID, '/filesystem.Filesystem/Stat', {
      path: '/home/user/dir',
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().code).toBe('not_found');
  });

  it('streams Process/Start: start, live data, end with the honest exit code', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const res = await startCommand(t, sandboxID, 'echo hi');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/connect+json');

    const frames = parseEnvelopes(res.rawPayload);
    const events = frames
      .filter((f) => f.flags === 0)
      .map((f) => f.json.event as Record<string, unknown>);
    expect(events[0]).toHaveProperty('start');
    const data = events.find((e) => 'data' in e) as {
      data: { stdout: string };
    };
    expect(Buffer.from(data.data.stdout, 'base64').toString('utf8')).toBe(
      'hi\n',
    );
    const end = events.at(-1) as { end: { exitCode: number; exited: boolean } };
    expect(end.end).toMatchObject({ exitCode: 0, exited: true });
    // The closing frame: flags 0x02, empty object — a clean end of stream.
    expect(frames.at(-1)).toEqual({ flags: 2, json: {} });
  });

  it('a nonzero exit is a result on the wire, never an error frame', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const frames = parseEnvelopes(
      (await startCommand(t, sandboxID, 'exit 7')).rawPayload,
    );
    const end = frames
      .filter((f) => f.flags === 0)
      .map((f) => f.json.event as Record<string, unknown>)
      .find((e) => 'end' in e) as { end: { exitCode: number } };
    expect(end.end.exitCode).toBe(7);
    expect(frames.at(-1)).toEqual({ flags: 2, json: {} });
  });

  it('sandbox-level envs sit under per-command envs', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t, {
      envVars: { FROM_SANDBOX: 'base', SHADOWED: 'under' },
    });
    const one = parseEnvelopes(
      (await startCommand(t, sandboxID, 'printenv FROM_SANDBOX')).rawPayload,
    )
      .filter((f) => f.flags === 0)
      .map((f) => f.json.event as { data?: { stdout?: string } })
      .find((e) => e.data?.stdout);
    expect(
      Buffer.from(one?.data?.stdout ?? '', 'base64').toString('utf8'),
    ).toBe('base\n');

    const two = parseEnvelopes(
      (
        await startCommand(t, sandboxID, 'printenv SHADOWED', {
          envs: { SHADOWED: 'over' },
        })
      ).rawPayload,
    )
      .filter((f) => f.flags === 0)
      .map((f) => f.json.event as { data?: { stdout?: string } })
      .find((e) => e.data?.stdout);
    expect(
      Buffer.from(two?.data?.stdout ?? '', 'base64').toString('utf8'),
    ).toBe('over\n');
  });

  it('user rides Basic auth: root runs as root, an unknown name is refused in both dialects', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const basic = (name: string) => ({
      authorization: `Basic ${Buffer.from(`${name}:`).toString('base64')}`,
    });

    // Streaming face: Start with Basic root — whoami answers root.
    const asRoot = await startCommand(t, sandboxID, 'whoami', {
      headers: basic('root'),
    });
    const events = parseEnvelopes(asRoot.rawPayload)
      .filter((f) => f.flags === 0)
      .map((f) => f.json.event as Record<string, unknown>);
    const data = events.find((e) => 'data' in e) as {
      data: { stdout: string };
    };
    expect(Buffer.from(data.data.stdout, 'base64').toString('utf8')).toBe(
      'root\n',
    );

    // Streaming face, unknown name: refused inside the stream, before start.
    const refused = await startCommand(t, sandboxID, 'whoami', {
      headers: basic('nobody'),
    });
    const frames = parseEnvelopes(refused.rawPayload);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      flags: 2,
      json: {
        error: {
          code: 'unauthenticated',
          message: "invalid username: 'nobody'",
        },
      },
    });

    // Unary face: same identity, same refusal, unary dialect.
    const stat = await t.app.inject({
      method: 'POST',
      url: '/e2b/envd/filesystem.Filesystem/Stat',
      headers: { ...envdHeaders(t, sandboxID), ...basic('root') },
      payload: { path: '/home/user' },
    });
    expect(stat.statusCode).toBe(200);
    const statRefused = await t.app.inject({
      method: 'POST',
      url: '/e2b/envd/filesystem.Filesystem/Stat',
      headers: { ...envdHeaders(t, sandboxID), ...basic('nobody') },
      payload: { path: '/home/user' },
    });
    expect(statRefused.statusCode).toBe(401);
    expect(statRefused.json()).toEqual({
      code: 'unauthenticated',
      message: "invalid username: 'nobody'",
    });

    // Files face: username in the query, vetted the same way.
    const filesRefused = await t.app.inject({
      method: 'GET',
      url: '/e2b/envd/files?path=x&username=nobody',
      headers: envdHeaders(t, sandboxID),
    });
    expect(filesRefused.statusCode).toBe(401);
    expect(filesRefused.json().message).toBe("invalid username: 'nobody'");
  });

  it('answers a blown connect-timeout-ms deadline with deadline_exceeded, not an end event', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const res = await startCommand(t, sandboxID, 'sleep 2', {
      headers: { 'connect-timeout-ms': '300' },
    });
    const last = parseEnvelopes(res.rawPayload).at(-1);
    expect(last?.flags).toBe(2);
    expect((last?.json.error as { code: string }).code).toBe(
      'deadline_exceeded',
    );
  });

  it('names what it does not support yet: unimplemented, with a hint', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const res = await envdRpc(t, sandboxID, '/process.Process/StreamInput', {});
    expect(res.statusCode).toBe(501);
    expect(res.json().code).toBe('unimplemented');
    expect(res.json().message).toContain('stdin');
  });

  it('stdin round-trips: Start with stdin, SendInput chunks, CloseStdin ends it', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const startRes = startCommand(t, sandboxID, 'cat', { stdin: true });
    const pid = await waitForPid(t, sandboxID);

    const sent = await envdRpc(t, sandboxID, '/process.Process/SendInput', {
      process: { pid },
      input: { stdin: Buffer.from('hello ').toString('base64') },
    });
    expect(sent.statusCode).toBe(200);
    await envdRpc(t, sandboxID, '/process.Process/SendInput', {
      process: { pid },
      input: { stdin: Buffer.from('world').toString('base64') },
    });
    const closed = await envdRpc(t, sandboxID, '/process.Process/CloseStdin', {
      process: { pid },
    });
    expect(closed.statusCode).toBe(200);

    const events = parseEnvelopes((await startRes).rawPayload)
      .filter((f) => f.flags === 0)
      .map((f) => f.json.event as Record<string, unknown>);
    expect(events[0]).toHaveProperty('start');
    const echoed = events
      .filter((e) => 'data' in e)
      .map((e) =>
        Buffer.from(
          (e as { data: { stdout: string } }).data.stdout,
          'base64',
        ).toString('utf8'),
      )
      .join('');
    expect(echoed).toBe('hello world');
    const end = events.at(-1) as { end: { exitCode: number } };
    expect(end.end.exitCode).toBe(0);
  });

  it('a blown deadline only detaches the stream: the process lives, Connect picks it back up', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const startRes = await startCommand(t, sandboxID, 'sleep 1; echo late', {
      headers: { 'connect-timeout-ms': '200' },
    });
    const startFrames = parseEnvelopes(startRes.rawPayload);
    expect((startFrames.at(-1)?.json.error as { code: string }).code).toBe(
      'deadline_exceeded',
    );
    const pid = (startFrames[0]?.json.event as { start: { pid: number } }).start
      .pid;

    // Still alive after the wire gave up — E2B's semantics, adopted on purpose.
    const list = await envdRpc(t, sandboxID, '/process.Process/List', {});
    expect(
      (list.json().processes as Array<{ pid: number }>).map((p) => p.pid),
    ).toContain(pid);

    // Connect must open with a start frame, then deliver the rest.
    const events = parseEnvelopes(
      (await connectProcess(t, sandboxID, pid)).rawPayload,
    )
      .filter((f) => f.flags === 0)
      .map((f) => f.json.event as Record<string, unknown>);
    expect(events[0]).toEqual({ start: { pid } });
    const late = events.find((e) => 'data' in e) as {
      data: { stdout: string };
    };
    expect(Buffer.from(late.data.stdout, 'base64').toString('utf8')).toBe(
      'late\n',
    );
    expect((events.at(-1) as { end: { exitCode: number } }).end.exitCode).toBe(
      0,
    );
  });

  it('Connect to an unknown pid answers not_found inside the stream', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const frames = parseEnvelopes(
      (await connectProcess(t, sandboxID, 424242)).rawPayload,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]?.flags).toBe(2);
    expect((frames[0]?.json.error as { code: string }).code).toBe('not_found');
  });

  it('List echoes a complete config and empties once the process exits', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const startRes = startCommand(t, sandboxID, 'sleep 30', {
      envs: { MARKER: 'yes' },
    });
    const pid = await waitForPid(t, sandboxID);

    const list = await envdRpc(t, sandboxID, '/process.Process/List', {});
    const procs = list.json().processes as Array<{
      pid: number;
      config: { cmd: string; args: string[]; envs: Record<string, string> };
    }>;
    expect(procs).toHaveLength(1);
    // The SDK dereferences config.cmd and config.args unconditionally.
    expect(procs[0]?.config.cmd).toBe('/bin/bash');
    expect(procs[0]?.config.args).toEqual(['-l', '-c', 'sleep 30']);
    expect(procs[0]?.config.envs).toEqual({ MARKER: 'yes' });

    await envdRpc(t, sandboxID, '/process.Process/SendSignal', {
      process: { pid },
      signal: 'SIGNAL_SIGKILL',
    });
    await startRes;
    const after = await envdRpc(t, sandboxID, '/process.Process/List', {});
    expect(after.json().processes).toEqual([]);
  });

  it('SendSignal kills: the stream ends 137/killed; a dead pid answers not_found', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const startRes = startCommand(t, sandboxID, 'sleep 30');
    const pid = await waitForPid(t, sandboxID);

    const killed = await envdRpc(t, sandboxID, '/process.Process/SendSignal', {
      process: { pid },
      signal: 'SIGNAL_SIGKILL',
    });
    expect(killed.statusCode).toBe(200);
    const events = parseEnvelopes((await startRes).rawPayload)
      .filter((f) => f.flags === 0)
      .map((f) => f.json.event as Record<string, unknown>);
    const end = events.at(-1) as {
      end: { exitCode: number; status: string };
    };
    expect(end.end).toMatchObject({ exitCode: 137, status: 'killed' });

    // The SDK turns not_found into kill() === false.
    const again = await envdRpc(t, sandboxID, '/process.Process/SendSignal', {
      process: { pid },
      signal: 'SIGNAL_SIGKILL',
    });
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe('not_found');
  });

  it("SendInput to a process started without stdin is the caller's confusion", async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const startRes = startCommand(t, sandboxID, 'sleep 30');
    const pid = await waitForPid(t, sandboxID);

    const res = await envdRpc(t, sandboxID, '/process.Process/SendInput', {
      process: { pid },
      input: { stdin: Buffer.from('x').toString('base64') },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_argument');
    expect(res.json().message).toBe('process was started without stdin');

    await envdRpc(t, sandboxID, '/process.Process/SendSignal', {
      process: { pid },
      signal: 'SIGNAL_SIGKILL',
    });
    await startRes;
  });

  it('PTY on the wire: output rides data.pty, input rides input.pty, Update resizes', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const startRes = startPty(t, sandboxID);
    const pid = await waitForPid(t, sandboxID);

    const typed = (text: string) =>
      envdRpc(t, sandboxID, '/process.Process/SendInput', {
        process: { pid },
        input: { pty: Buffer.from(text).toString('base64') },
      });
    expect((await typed('echo over-the-pty\r')).statusCode).toBe(200);
    const resized = await envdRpc(t, sandboxID, '/process.Process/Update', {
      process: { pid },
      pty: { size: { cols: 100, rows: 30 } },
    });
    expect(resized.statusCode).toBe(200);
    await typed('stty size\r');
    await typed('exit\r');

    const events = parseEnvelopes((await startRes).rawPayload)
      .filter((f) => f.flags === 0)
      .map((f) => f.json.event as Record<string, unknown>);
    const dataFrames = events.filter((e) => 'data' in e) as Array<{
      data: { pty?: string; stdout?: string };
    }>;
    // A terminal is one merged stream: every data frame rides the pty field.
    expect(dataFrames.every((e) => e.data.pty !== undefined)).toBe(true);
    const terminal = dataFrames
      .map((e) => Buffer.from(e.data.pty ?? '', 'base64').toString('utf8'))
      .join('');
    expect(terminal).toContain('over-the-pty');
    expect(terminal).toContain('30 100');
    expect((events.at(-1) as { end: { exitCode: number } }).end.exitCode).toBe(
      0,
    );
  });

  it('input channel and start promise must match', async () => {
    const t = testApp();

    // stdin bytes into a PTY session: the terminal is not a stdin pipe.
    const ptyBox = await createSandbox(t);
    const ptyRes = startPty(t, ptyBox.sandboxID);
    const ptyPid = await waitForPid(t, ptyBox.sandboxID);
    const wrongStdin = await envdRpc(
      t,
      ptyBox.sandboxID,
      '/process.Process/SendInput',
      {
        process: { pid: ptyPid },
        input: { stdin: Buffer.from('x').toString('base64') },
      },
    );
    expect(wrongStdin.statusCode).toBe(400);
    expect(wrongStdin.json().message).toBe('process was started without stdin');

    // pty bytes into a plain command: there is no terminal to type at.
    const plainBox = await createSandbox(t);
    const plainRes = startCommand(t, plainBox.sandboxID, 'sleep 30');
    const plainPid = await waitForPid(t, plainBox.sandboxID);
    const wrongPty = await envdRpc(
      t,
      plainBox.sandboxID,
      '/process.Process/SendInput',
      {
        process: { pid: plainPid },
        input: { pty: Buffer.from('x').toString('base64') },
      },
    );
    expect(wrongPty.statusCode).toBe(400);
    expect(wrongPty.json().message).toBe('process has no PTY');

    // Reap both, or their day-long wire deadlines outlive the test run.
    for (const [box, pid] of [
      [ptyBox.sandboxID, ptyPid],
      [plainBox.sandboxID, plainPid],
    ] as const) {
      await envdRpc(t, box, '/process.Process/SendSignal', {
        process: { pid },
        signal: 'SIGNAL_SIGKILL',
      });
    }
    await Promise.all([ptyRes, plainRes]);
  });

  it('a detached background process does not keep the sandbox warm', async () => {
    const t = testApp();
    // A day-long TTL so the idle scanner speaks first — at the default 300s
    // the kill-deadline would destroy the sandbox before freeze gets a turn.
    const { sandboxID } = await createSandbox(t, { timeout: 86400 });
    // Detach via the wire deadline: the process sleeps on, unwatched.
    await startCommand(t, sandboxID, 'sleep 600', {
      headers: { 'connect-timeout-ms': '100' },
    });
    expect(
      (await envdRpc(t, sandboxID, '/process.Process/List', {})).json()
        .processes,
    ).toHaveLength(1);

    // The idle scanner, told it is an hour later, freezes the sandbox —
    // no heartbeat outlives its stream; only attached streams keep warmth.
    const row = findBySandboxId(t.db, sandboxID);
    const later = new Date(
      Date.now() + ((row?.freezeAfterSeconds ?? 0) + 60) * 1000,
    );
    await scanOnce(t.db, t.executor, t.locks, later);
    expect(t.executor.stateOf(sandboxID)).toBe('paused');
  });

  it('exec on a paused sandbox answers unavailable inside the stream — like a dead E2B box', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    await control(t, 'POST', `/sandboxes/${sandboxID}/pause`, {});
    const res = await startCommand(t, sandboxID, 'echo hi');
    expect(res.statusCode).toBe(200);
    const frames = parseEnvelopes(res.rawPayload);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.flags).toBe(2);
    expect((frames[0]?.json.error as { code: string }).code).toBe(
      'unavailable',
    );
  });

  // ---- directory watching -----------------------------------------------

  /** WatchDir with a wire deadline: the SDK's watch shape, ending honestly. */
  function watchDir(
    t: TestApp,
    sandboxID: string,
    body: Record<string, unknown>,
    deadlineMs: number,
  ) {
    return t.app.inject({
      method: 'POST',
      url: '/e2b/envd/filesystem.Filesystem/WatchDir',
      headers: {
        ...envdHeaders(t, sandboxID),
        'content-type': 'application/connect+json',
        'connect-timeout-ms': String(deadlineMs),
      },
      payload: enveloped(body),
    });
  }

  it('WatchDir opens with start, streams filesystem events, and ends at the deadline', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const pending = watchDir(t, sandboxID, { path: '/home/user' }, 600);
    // The change arrives from the side while the stream hangs open — the
    // executor's disk is the same one the watch observes.
    setTimeout(() => {
      void t.executor.writeFiles(sandboxID, [
        { path: 'watched.txt', content: Buffer.from('x') },
      ]);
    }, 100);
    const res = await pending;
    expect(res.statusCode).toBe(200);
    const frames = parseEnvelopes(res.rawPayload);
    // Start frame strictly first — the SDK's hard requirement.
    expect(frames[0]?.json).toEqual({ start: {} });
    const events = frames
      .map((f) => f.json.filesystem as { name: string; type: string })
      .filter(Boolean);
    expect(events).toContainEqual({
      name: 'watched.txt',
      type: 'EVENT_TYPE_CREATE',
    });
    expect(events).toContainEqual({
      name: 'watched.txt',
      type: 'EVENT_TYPE_WRITE',
    });
    const last = frames[frames.length - 1];
    expect(last?.flags).toBe(2);
    expect((last?.json.error as { code: string }).code).toBe(
      'deadline_exceeded',
    );
  });

  it('WatchDir refuses a missing path and a file before any start frame', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const missing = await watchDir(
      t,
      sandboxID,
      { path: '/home/user/nowhere' },
      500,
    );
    const missingFrames = parseEnvelopes(missing.rawPayload);
    expect(missingFrames).toHaveLength(1);
    expect(missingFrames[0]?.flags).toBe(2);
    expect(missingFrames[0]?.json.error).toEqual({
      code: 'not_found',
      message: 'no such file: /home/user/nowhere',
    });

    await t.executor.writeFiles(sandboxID, [
      { path: 'plain.txt', content: Buffer.from('x') },
    ]);
    const onFile = await watchDir(t, sandboxID, { path: 'plain.txt' }, 500);
    const fileFrames = parseEnvelopes(onFile.rawPayload);
    expect(fileFrames).toHaveLength(1);
    expect(fileFrames[0]?.json.error).toEqual({
      code: 'invalid_argument',
      message: 'not a directory: /home/user/plain.txt',
    });
  });

  it('an attached watch does not keep the sandbox warm — the scanner freezes it', async () => {
    const t = testApp();
    // Day-long TTL so the idle scanner speaks before the kill deadline.
    const { sandboxID } = await createSandbox(t, { timeout: 86400 });
    let stateDuringWatch: string | undefined;
    const pending = watchDir(t, sandboxID, { path: '/home/user' }, 600);
    setTimeout(() => {
      void (async () => {
        const row = findBySandboxId(t.db, sandboxID);
        const later = new Date(
          Date.now() + ((row?.freezeAfterSeconds ?? 0) + 60) * 1000,
        );
        await scanOnce(t.db, t.executor, t.locks, later);
        stateDuringWatch = t.executor.stateOf(sandboxID);
      })();
    }, 100);
    const res = await pending;
    // Frozen mid-watch: no heartbeat held the sandbox awake, and the stream
    // itself still ended through its own deadline, not through an error.
    expect(stateDuringWatch).toBe('paused');
    const frames = parseEnvelopes(res.rawPayload);
    const last = frames[frames.length - 1];
    expect((last?.json.error as { code: string }).code).toBe(
      'deadline_exceeded',
    );
  });

  it('the polling trio: create, drain, drain empty, remove, then not_found', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const created = await envdRpc(
      t,
      sandboxID,
      '/filesystem.Filesystem/CreateWatcher',
      { path: '/home/user' },
    );
    expect(created.statusCode).toBe(200);
    const { watcherId } = created.json() as { watcherId: string };
    expect(watcherId).toBeTruthy();

    await t.executor.writeFiles(sandboxID, [
      { path: 'polled.txt', content: Buffer.from('x') },
    ]);
    const first = await envdRpc(
      t,
      sandboxID,
      '/filesystem.Filesystem/GetWatcherEvents',
      { watcherId },
    );
    expect(first.json().events).toContainEqual({
      name: 'polled.txt',
      type: 'EVENT_TYPE_CREATE',
    });
    // Drained means drained: the second poll answers empty.
    const second = await envdRpc(
      t,
      sandboxID,
      '/filesystem.Filesystem/GetWatcherEvents',
      { watcherId },
    );
    expect(second.json().events).toEqual([]);

    const removed = await envdRpc(
      t,
      sandboxID,
      '/filesystem.Filesystem/RemoveWatcher',
      { watcherId },
    );
    expect(removed.statusCode).toBe(200);
    const gone = await envdRpc(
      t,
      sandboxID,
      '/filesystem.Filesystem/GetWatcherEvents',
      { watcherId },
    );
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toEqual({
      code: 'not_found',
      message: `watcher with id ${watcherId} not found`,
    });
  });

  it('a polled watcher dies with its container: the next poll answers not_found', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const created = await envdRpc(
      t,
      sandboxID,
      '/filesystem.Filesystem/CreateWatcher',
      { path: '/home/user' },
    );
    const { watcherId } = created.json() as { watcherId: string };
    // The container stops under the watcher (physically, past the ledger —
    // the conduction being tested is executor -> watcher table).
    await t.executor.freeze(sandboxID);
    await t.executor.stop(sandboxID);
    await t.executor.start(sandboxID);
    const res = await envdRpc(
      t,
      sandboxID,
      '/filesystem.Filesystem/GetWatcherEvents',
      { watcherId },
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });

  it('CreateWatcher validates the path with the unary error dialect', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t);
    const missing = await envdRpc(
      t,
      sandboxID,
      '/filesystem.Filesystem/CreateWatcher',
      { path: '/home/user/nowhere' },
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      code: 'not_found',
      message: 'no such file: /home/user/nowhere',
    });
  });
});

/**
 * The signature exactly as the official SDK computes it (signature.ts in
 * the e2b package) — deliberately re-implemented here instead of importing
 * our signing.ts, so the test pins both ends of the wire independently.
 */
function sdkSignature(opts: {
  path?: string;
  operation: 'read' | 'write';
  user?: string;
  envdAccessToken: string;
  expiration?: number;
}): string {
  const raw = [
    opts.path ?? '',
    opts.operation,
    opts.user ?? '',
    opts.envdAccessToken,
    ...(opts.expiration === undefined ? [] : [String(opts.expiration)]),
  ].join(':');
  const hash = createHash('sha256').update(raw, 'utf8').digest('base64');
  return `v1_${hash.replace(/=+$/, '')}`;
}

/** Writes a file through the envd surface — the signed tests' fixture pen. */
async function putFile(
  t: TestApp,
  sandboxID: string,
  path: string,
  content: string,
) {
  const res = await t.app.inject({
    method: 'POST',
    url: `/e2b/envd/files?path=${encodeURIComponent(path)}`,
    headers: {
      ...envdHeaders(t, sandboxID),
      'content-type': 'application/octet-stream',
    },
    payload: content,
  });
  expect(res.statusCode).toBe(200);
}

describe('signed file URLs at the daemon root', () => {
  it('a bare signed GET /files downloads — the signature is auth AND identity', async () => {
    const t = testApp();
    const a = await createSandbox(t);
    const b = await createSandbox(t);
    // The same path in two sandboxes, different content: only the
    // signature says which sandbox the URL speaks for.
    await putFile(t, a.sandboxID, 'secret.txt', 'contents of A\n');
    await putFile(t, b.sandboxID, 'secret.txt', 'contents of B\n');

    const download = (token: string, expiration?: number) => {
      const sig = sdkSignature({
        path: 'secret.txt',
        operation: 'read',
        envdAccessToken: token,
        ...(expiration === undefined ? {} : { expiration }),
      });
      const exp =
        expiration === undefined ? '' : `&signature_expiration=${expiration}`;
      // No headers at all — exactly what a browser hitting the URL sends.
      return t.app.inject({
        method: 'GET',
        url: `/files?path=secret.txt&signature=${encodeURIComponent(sig)}${exp}`,
      });
    };

    const fromA = await download(a.envdAccessToken);
    expect(fromA.statusCode).toBe(200);
    expect(fromA.body).toBe('contents of A\n');

    // With a future expiration in the material — the second signing shape.
    const exp = Math.floor(Date.now() / 1000) + 300;
    const fromB = await download(b.envdAccessToken, exp);
    expect(fromB.statusCode).toBe(200);
    expect(fromB.body).toBe('contents of B\n');
  });

  it('signed uploads: multipart carries the path in the filename, octet-stream in the query', async () => {
    const t = testApp();
    const { sandboxID, envdAccessToken } = await createSandbox(t);

    // uploadUrl without a path signs the empty string and sends no ?path=.
    const multipartSig = sdkSignature({
      operation: 'write',
      envdAccessToken,
    });
    const boundary = 'dormice-signed-boundary';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="signed/up.txt"',
      'Content-Type: application/octet-stream',
      '',
      'through the signed door\n',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const up = await t.app.inject({
      method: 'POST',
      url: `/files?signature=${encodeURIComponent(multipartSig)}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toEqual([
      { name: 'up.txt', type: 'file', path: '/home/user/signed/up.txt' },
    ]);

    const octetSig = sdkSignature({
      path: 'signed/oct.txt',
      operation: 'write',
      envdAccessToken,
    });
    const oct = await t.app.inject({
      method: 'POST',
      url: `/files?path=${encodeURIComponent('signed/oct.txt')}&signature=${encodeURIComponent(octetSig)}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: 'octets through the signed door\n',
    });
    expect(oct.statusCode).toBe(200);

    // Both landed in the sandbox, readable through the envd surface.
    const back = await t.app.inject({
      method: 'GET',
      url: '/e2b/envd/files?path=signed/oct.txt',
      headers: envdHeaders(t, sandboxID),
    });
    expect(back.body).toBe('octets through the signed door\n');
  });

  it("refuses in real envd's order and words", async () => {
    const t = testApp();
    const { envdAccessToken } = await createSandbox(t);

    const missing = await t.app.inject({ method: 'GET', url: '/files?path=x' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({
      code: 'unauthenticated',
      message: 'missing signature query parameter',
    });

    const wrong = await t.app.inject({
      method: 'GET',
      url: '/files?path=x&signature=v1_forged',
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().message).toBe('invalid signature');

    // A valid signature whose material includes a past expiration: the
    // match succeeds, the clock refuses.
    const past = Math.floor(Date.now() / 1000) - 10;
    const expiredSig = sdkSignature({
      path: 'x',
      operation: 'read',
      envdAccessToken,
      expiration: past,
    });
    const expired = await t.app.inject({
      method: 'GET',
      url: `/files?path=x&signature=${encodeURIComponent(expiredSig)}&signature_expiration=${past}`,
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().message).toBe('signature is already expired');

    // A wrong signature that also claims a past expiration must say
    // "invalid signature" — the signature check comes first, so a forger
    // never learns whether their expiry was the problem.
    const forgedExpired = await t.app.inject({
      method: 'GET',
      url: `/files?path=x&signature=v1_forged&signature_expiration=${past}`,
    });
    expect(forgedExpired.json().message).toBe('invalid signature');

    // A read signature opens no write door: the operation is in the material.
    const readSig = sdkSignature({
      path: 'x',
      operation: 'read',
      envdAccessToken,
    });
    const misused = await t.app.inject({
      method: 'POST',
      url: `/files?path=x&signature=${encodeURIComponent(readSig)}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: 'nope',
    });
    expect(misused.statusCode).toBe(401);
    expect(misused.json().message).toBe('invalid signature');

    // The root door is signature-only: a header token belongs to
    // /e2b/envd/files and buys nothing here.
    const headerOnly = await t.app.inject({
      method: 'GET',
      url: '/files?path=x',
      headers: { 'x-access-token': envdAccessToken },
    });
    expect(headerOnly.statusCode).toBe(401);
    expect(headerOnly.json().message).toBe('missing signature query parameter');
  });

  it('a signed download wakes a frozen sandbox — autoResume through the bare door', async () => {
    const t = testApp();
    const { sandboxID, envdAccessToken } = await createSandbox(t, {
      timeout: 86400,
    });
    await putFile(t, sandboxID, 'frozen.txt', 'still here\n');
    const row = findBySandboxId(t.db, sandboxID);
    const later = new Date(
      Date.now() + ((row?.freezeAfterSeconds ?? 0) + 60) * 1000,
    );
    await scanOnce(t.db, t.executor, t.locks, later);
    expect(t.executor.stateOf(sandboxID)).toBe('paused');

    const sig = sdkSignature({
      path: 'frozen.txt',
      operation: 'read',
      envdAccessToken,
    });
    const res = await t.app.inject({
      method: 'GET',
      url: `/files?path=frozen.txt&signature=${encodeURIComponent(sig)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('still here\n');
    expect(t.executor.stateOf(sandboxID)).toBe('running');
  });

  it("vets the signed username: only the image's users exist", async () => {
    const t = testApp();
    const { sandboxID, envdAccessToken } = await createSandbox(t);
    const sig = sdkSignature({
      path: 'x',
      operation: 'read',
      user: 'nobody',
      envdAccessToken,
    });
    const res = await t.app.inject({
      method: 'GET',
      url: `/files?path=x&username=nobody&signature=${encodeURIComponent(sig)}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe("invalid username: 'nobody'");

    // root exists: a root-signed download passes the vet (the fake has no
    // permission model — root's real powers are the docker e2e's business).
    await putFile(t, sandboxID, 'rooted.txt', 'root readable\n');
    const rootSig = sdkSignature({
      path: 'rooted.txt',
      operation: 'read',
      user: 'root',
      envdAccessToken,
    });
    const asRoot = await t.app.inject({
      method: 'GET',
      url: `/files?path=rooted.txt&username=root&signature=${encodeURIComponent(rootSig)}`,
    });
    expect(asRoot.statusCode).toBe(200);
    expect(asRoot.body).toBe('root readable\n');
  });
});

describe('E2B templates', () => {
  // Registration is a native verb; the compat surface only consumes it.
  async function registerTemplate(t: TestApp, name: string, image: string) {
    const res = await t.app.inject({
      method: 'POST',
      url: '/registerTemplate',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { name, image },
    });
    expect(res.statusCode).toBe(200);
  }

  it('creates from a registered templateID: its image boots, name echoes as templateID and alias', async () => {
    const t = testApp();
    await registerTemplate(t, 'py311', 'img-py');
    const res = await control(t, 'POST', '/sandboxes', { templateID: 'py311' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.templateID).toBe('py311');
    expect(body.alias).toBe('py311');
    // The physical half: the shell was born from the template's image.
    expect(await t.executor.imageOf(body.sandboxID)).toBe('img-py');

    const info = await control(t, 'GET', `/sandboxes/${body.sandboxID}`);
    // The SDK maps wire templateID -> SandboxInfo.templateId and a truthy
    // alias -> SandboxInfo.name.
    expect(info.json()).toMatchObject({ templateID: 'py311', alias: 'py311' });
  });

  it('answers an unknown templateID with 404 in the control-plane dialect', async () => {
    const res = await control(testApp(), 'POST', '/sandboxes', {
      templateID: 'nope',
    });
    expect(res.statusCode).toBe(404);
    // openapi-fetch parses this body; the SDK then throws
    // SandboxError("404: template 'nope' not found").
    expect(res.json()).toEqual({
      code: 404,
      message: "template 'nope' not found",
    });
  });

  it("'base', the configured base image name, and absence all mean the base image", async () => {
    const t = testApp(new FakeExecutor(), {
      DORMICE_BASE_IMAGE: 'dormice-base:test',
    });
    for (const payload of [
      {},
      { templateID: 'base' },
      { templateID: 'dormice-base:test' },
    ]) {
      const res = await control(t, 'POST', '/sandboxes', payload);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      // Echo keeps the pre-templates shape: the base image name, no alias.
      expect(body.templateID).toBe('dormice-base:test');
      expect(body.alias).toBeUndefined();
      expect(await t.executor.imageOf(body.sandboxID)).toBe(FAKE_BASE_IMAGE);
    }
  });

  it('externalId reuse keeps the original template; an unknown one still 404s first', async () => {
    const t = testApp();
    await registerTemplate(t, 'tpl-a', 'img-a');
    await registerTemplate(t, 'tpl-b', 'img-b');
    const first = await createSandbox(t, {
      templateID: 'tpl-a',
      metadata: { externalId: 'alice' },
    });

    // Same key, different template: the stored one stays — same principle
    // as metadata and envs on the reuse path.
    const again = await control(t, 'POST', '/sandboxes', {
      templateID: 'tpl-b',
      metadata: { externalId: 'alice' },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().sandboxID).toBe(first.sandboxID);
    expect(again.json().templateID).toBe('tpl-a');

    // Validation happens before the reuse shortcut: a typo is a typo.
    const typo = await control(t, 'POST', '/sandboxes', {
      templateID: 'ghost',
      metadata: { externalId: 'alice' },
    });
    expect(typo.statusCode).toBe(404);
  });

  it('list items carry the template as templateID', async () => {
    const t = testApp();
    await registerTemplate(t, 'py311', 'img-py');
    await createSandbox(t, {
      templateID: 'py311',
      metadata: { externalId: 'tpl-list' },
    });
    const res = await control(t, 'GET', '/v2/sandboxes');
    const items = res.json() as Array<{ templateID: string; alias?: string }>;
    expect(items).toMatchObject([{ templateID: 'py311', alias: 'py311' }]);
  });
});

describe('E2B surface vs the archiver', () => {
  /** testApp plus a MemStore-backed archiver — the S3-configured daemon. */
  function archiverTestApp(executor: FakeExecutor = new FakeExecutor()) {
    const db = openDb(':memory:');
    migrateDb(db, MIGRATIONS);
    const config = loadConfig({
      DORMICE_DB_PATH: ':memory:',
      DORMICE_NODE_ID: 'node-test',
      DORMICE_API_TOKEN: TOKEN,
    });
    const locks = new KeyedQueue();
    const store = new MemStore();
    const archiver = new Archiver({
      db,
      executor,
      locks,
      store,
      tmpDir: mkdtempSync(path.join(tmpdir(), 'dormice-compat-')),
    });
    const app = buildApp({
      config,
      db,
      executor,
      locks,
      logger: false,
      archiver,
    });
    return { app, db, executor, locks, store, archiver };
  }

  /**
   * Walks an autoPause sandbox down to archived. Only pause-type sandboxes
   * can ever get there on this surface: a kill-type deadline destroys the
   * sandbox long before any archive threshold — which is why every test
   * here creates with autoPause.
   */
  async function walkToArchived(
    t: ReturnType<typeof archiverTestApp>,
    sandboxID: string,
  ): Promise<void> {
    const row = findBySandboxId(t.db, sandboxID);
    if (!row) throw new Error('row missing');
    const at = (s: number) => new Date(Date.parse(row.lastActiveAt) + s * 1000);
    // The scanner sweeps travel in time, but e2bView reads the ledger's
    // deadline against the real clock — so the deadline is planted in the
    // real past, the shape a 7-days-idle autoPause sandbox actually has.
    setDeadline(t.db, sandboxID, {
      deadlineAt: new Date(Date.parse(row.lastActiveAt) - 1000).toISOString(),
      onDeadline: 'pause',
    });
    // The expired pause deadline parks it frozen; the default idle policy
    // then stops it at 3 days and archives it at 7.
    await scanOnce(t.db, t.executor, t.locks, at(300), t.archiver);
    await scanOnce(t.db, t.executor, t.locks, at(3 * 86400), t.archiver);
    await scanOnce(t.db, t.executor, t.locks, at(7 * 86400), t.archiver);
    expect(findBySandboxId(t.db, sandboxID)?.state).toBe('archived');
    expect(t.store.has(objectKey(sandboxID))).toBe(true);
  }

  it('reports an archived autoPause sandbox as paused — archived is not a wire state', async () => {
    const t = archiverTestApp();
    const { sandboxID } = await createSandbox(t, { autoPause: true });
    await walkToArchived(t, sandboxID);
    const res = await control(t, 'GET', '/v2/sandboxes?state=paused');
    expect(
      (res.json() as Array<{ sandboxID: string }>).map((s) => s.sandboxID),
    ).toContain(sandboxID);
  });

  it('connect blocks through the restore and answers a live session', async () => {
    const t = archiverTestApp();
    const { sandboxID } = await createSandbox(t, { autoPause: true });
    await walkToArchived(t, sandboxID);

    const res = await control(t, 'POST', `/sandboxes/${sandboxID}/connect`, {});
    // 201 = this connect resumed it — same answer as resuming a pause.
    expect(res.statusCode).toBe(201);
    expect(t.executor.stateOf(sandboxID)).toBe('running');
    // The envd face serves immediately: the restore really finished.
    const list = await envdRpc(t, sandboxID, '/process.Process/List', {});
    expect(list.statusCode).toBe(200);
  });

  it('answers 502 for envd on a paused-archived sandbox WITHOUT restoring it', async () => {
    // The logical gate outranks the restore: a paused sandbox refuses envd
    // traffic whether frozen or archived, and refusing must not cost a
    // whole restore first. connect (which extends the deadline) is the way
    // back in — same as for a plain paused sandbox.
    const t = archiverTestApp();
    const { sandboxID } = await createSandbox(t, { autoPause: true });
    await walkToArchived(t, sandboxID);

    const stat = await envdRpc(t, sandboxID, '/filesystem.Filesystem/Stat', {
      path: '/home/user',
    });
    expect(stat.statusCode).toBe(502);
    expect(findBySandboxId(t.db, sandboxID)?.state).toBe('archived');
    expect(t.store.has(objectKey(sandboxID))).toBe(true);
  });

  it('the envd face restores a logically-running archived sandbox on first touch', async () => {
    // A natively-acquired sandbox has no deadline — archived by idleness,
    // it is still logically running, and envd traffic (a console terminal,
    // a signed URL) restores it in place.
    const t = archiverTestApp();
    const acquired = await t.app.inject({
      method: 'POST',
      url: '/acquireSandbox',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        externalId: 'native',
        policy: {
          freezeAfterSeconds: 1,
          stopAfterSeconds: 2,
          archiveAfterSeconds: 3,
        },
      },
    });
    const sandboxID = acquired.json().sandbox.sandboxId as string;
    const row = findBySandboxId(t.db, sandboxID);
    if (!row) throw new Error('row missing');
    const at = (s: number) => new Date(Date.parse(row.lastActiveAt) + s * 1000);
    await scanOnce(t.db, t.executor, t.locks, at(1), t.archiver);
    await scanOnce(t.db, t.executor, t.locks, at(2), t.archiver);
    await scanOnce(t.db, t.executor, t.locks, at(3), t.archiver);
    expect(findBySandboxId(t.db, sandboxID)?.state).toBe('archived');

    const stat = await envdRpc(t, sandboxID, '/filesystem.Filesystem/Stat', {
      path: '/home/user',
    });
    expect(stat.statusCode).toBe(200);
    expect(t.executor.stateOf(sandboxID)).toBe('running');
    expect(findBySandboxId(t.db, sandboxID)?.state).toBe('active');
  });

  it('create with metadata.externalId resumes its archived sandbox', async () => {
    const t = archiverTestApp();
    const first = await createSandbox(t, {
      autoPause: true,
      metadata: { externalId: 'alice' },
    });
    await walkToArchived(t, first.sandboxID);

    const res = await control(t, 'POST', '/sandboxes', {
      metadata: { externalId: 'alice' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().sandboxID).toBe(first.sandboxID);
    expect(t.executor.stateOf(first.sandboxID)).toBe('running');
  });

  it('kill deletes an archived sandbox and its S3 object', async () => {
    const t = archiverTestApp();
    const { sandboxID } = await createSandbox(t, { autoPause: true });
    await walkToArchived(t, sandboxID);

    const res = await control(t, 'DELETE', `/sandboxes/${sandboxID}`);
    expect(res.statusCode).toBe(204);
    expect(t.store.has(objectKey(sandboxID))).toBe(false);
    expect(findBySandboxId(t.db, sandboxID)).toBeUndefined();
  });

  it('kill mid-restore joins the task first, then deletes', async () => {
    const t = archiverTestApp();
    const { sandboxID } = await createSandbox(t, { autoPause: true });
    await walkToArchived(t, sandboxID);
    // Hold the download open so the row is mid-restoring when kill arrives.
    let releaseDownload!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const innerGet = t.store.get.bind(t.store);
    t.store.get = async (key, dest, onProgress) => {
      await gate;
      return innerGet(key, dest, onProgress);
    };
    const row = findBySandboxId(t.db, sandboxID);
    if (!row) throw new Error('row missing');
    t.archiver.beginRestore(row);
    expect(findBySandboxId(t.db, sandboxID)?.state).toBe('restoring');

    const del = control(t, 'DELETE', `/sandboxes/${sandboxID}`);
    // Let the DELETE reach its join, then release the download.
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseDownload();
    const res = await del;
    expect(res.statusCode).toBe(204);
    expect(t.store.has(objectKey(sandboxID))).toBe(false);
    expect(findBySandboxId(t.db, sandboxID)).toBeUndefined();
  });
});
