import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { migrateDb, openDb } from '../db/db';
import { findBySandboxId, setDeadline } from '../db/ledger';
import { FakeExecutor } from '../executor/fake';
import { KeyedQueue } from '../keyed-queue';
import { scanOnce } from '../scanner';
import { mintEnvdToken } from './protocol';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const TOKEN = 'test-token-test-token-test-token';

function testApp(executor: FakeExecutor = new FakeExecutor()) {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const config = loadConfig({
    DORMICE_DB_PATH: ':memory:',
    DORMICE_NODE_ID: 'node-test',
    DORMICE_API_TOKEN: TOKEN,
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

function envdHeaders(sandboxID: string) {
  return {
    'e2b-sandbox-id': sandboxID,
    'x-access-token': mintEnvdToken(TOKEN, sandboxID),
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
    headers: envdHeaders(sandboxID),
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
      ...envdHeaders(sandboxID),
      'content-type': 'application/connect+json',
      ...opts.headers,
    },
    payload: enveloped(message),
  });
}

function connectProcess(t: TestApp, sandboxID: string, pid: number) {
  return t.app.inject({
    method: 'POST',
    url: '/e2b/envd/process.Process/Connect',
    headers: {
      ...envdHeaders(sandboxID),
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
    expect(first.envdAccessToken).toBe(mintEnvdToken(TOKEN, first.sandboxID));
    expect(t.executor.stateOf(first.sandboxID)).toBe('running');
  });

  it('metadata.userKey is the Dormice extension: same key, same sandbox', async () => {
    const t = testApp();
    const first = await createSandbox(t, { metadata: { userKey: 'agent-7' } });
    const second = await createSandbox(t, { metadata: { userKey: 'agent-7' } });
    expect(second.sandboxID).toBe(first.sandboxID);
  });

  it('getInfo echoes metadata and reports the deadline as endAt', async () => {
    const t = testApp();
    const { sandboxID } = await createSandbox(t, {
      timeout: 600,
      metadata: { userKey: 'meta-echo', team: 'blue' },
    });
    const res = await control(t, 'GET', `/sandboxes/${sandboxID}`);
    expect(res.statusCode).toBe(200);
    const info = res.json();
    expect(info.state).toBe('running');
    expect(info.metadata).toEqual({ userKey: 'meta-echo', team: 'blue' });
    const endInMs = Date.parse(info.endAt) - Date.now();
    expect(endInMs).toBeGreaterThan(590_000);
    expect(endInMs).toBeLessThan(610_000);
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

  it('never imposes a deadline on a natively-acquired sandbox', async () => {
    const t = testApp();
    const native = await t.app.inject({
      method: 'POST',
      url: '/acquireSandbox',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { userKey: 'native-immortal' },
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
        ...envdHeaders(sandboxID),
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
      headers: envdHeaders(sandboxID),
    });
    expect(down.statusCode).toBe(200);
    expect(down.headers['content-length']).toBe(String(content.length));
    expect(down.body).toBe(content);

    const missing = await t.app.inject({
      method: 'GET',
      url: '/e2b/envd/files?path=/home/user/void.txt',
      headers: envdHeaders(sandboxID),
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
        ...envdHeaders(sandboxID),
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from([1, 2, 3, 250]),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { name: 'raw.bin', type: 'file', path: '/home/user/raw.bin' },
    ]);
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
        ...envdHeaders(sandboxID),
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
});
