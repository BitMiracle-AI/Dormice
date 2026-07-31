import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { Archiver } from '../archive/archiver';
import { MemStore } from '../archive/mem-store';
import { loadConfig } from '../config';
import { migrateDb, openDb } from '../db/db';
import { findByName } from '../db/ledger';
import { FakeExecutor } from '../executor/fake';
import { KeyedQueue } from '../keyed-queue';
import { scanOnce } from '../scanner';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const TOKEN = 'test-token-test-token-test-token';

/**
 * The per-sandbox spec surface: acquire's creation-time override, the two
 * update verbs (updateSpec, expandDisk), the resolved view, the cold-wake
 * convergence, and the restore path — against the fake executor, whose
 * limitsOf/metrics expose exactly what a shell and disk were born with.
 * Config defaults in force here: 1 cpu, 2 GiB memory, 10 GiB disk.
 */
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

/** testApp plus a MemStore archiver — the S3-configured daemon (app.test.ts's pattern). */
function archiverTestApp(executor: FakeExecutor = new FakeExecutor()) {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const config = loadConfig({
    DORMICE_DB_PATH: ':memory:',
    DORMICE_NODE_ID: 'node-test',
    DORMICE_API_TOKEN: TOKEN,
    DORMICE_S3_ENDPOINT: 'http://127.0.0.1:9000',
    DORMICE_S3_BUCKET: 'exam',
    DORMICE_S3_ACCESS_KEY_ID: 'exam-key',
    DORMICE_S3_SECRET_ACCESS_KEY: 'exam-secret',
  });
  const locks = new KeyedQueue();
  const store = new MemStore();
  const archiver = new Archiver({
    db,
    executor,
    locks,
    store,
    tmpDir: mkdtempSync(path.join(tmpdir(), 'dormice-spec-')),
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

const authed = { authorization: `Bearer ${TOKEN}` };

function rpc(
  app: ReturnType<typeof testApp>['app'],
  url: string,
  payload: Record<string, unknown> = {},
) {
  return app.inject({ method: 'POST', url, headers: authed, payload });
}

function acquire(
  app: ReturnType<typeof testApp>['app'],
  payload: Record<string, unknown>,
) {
  return rpc(app, '/acquireSandbox', payload);
}

async function activityKinds(app: ReturnType<typeof testApp>['app']) {
  const events = (await rpc(app, '/listActivity')).json().events as Array<{
    kind: string;
  }>;
  return events.map((event) => event.kind);
}

/** Time travel for the scanner, app.test.ts's helper. */
function after(iso: string, seconds: number): Date {
  return new Date(Date.parse(iso) + seconds * 1000);
}

describe('acquireSandbox spec override', () => {
  it('reports the global defaults as the resolved spec when nothing is asked', async () => {
    const { app } = testApp();
    const body = (await acquire(app, { name: 'alice' })).json();
    expect(body.sandbox.spec).toEqual({ cpus: 1, memoryGb: 2, diskGb: 10 });
  });

  it('stores the override, births the shell and disk with it, and reports it resolved', async () => {
    const { app, executor } = testApp();
    const body = (
      await acquire(app, {
        name: 'alice',
        spec: { cpus: 2, memoryGb: 4, diskGb: 20 },
      })
    ).json();
    expect(body.sandbox.spec).toEqual({ cpus: 2, memoryGb: 4, diskGb: 20 });
    // Reality agrees with the ledger: the shell and disk were born sized.
    expect(await executor.limitsOf(body.sandbox.id)).toEqual({
      nanoCpus: 2e9,
      memoryBytes: 4 * 1024 ** 3,
    });
    expect((await executor.metrics(body.sandbox.id)).diskTotalBytes).toBe(
      20 * 1024 ** 3,
    );
  });

  it('a partial override pins only the named knobs; the rest follow the defaults', async () => {
    const { app, db } = testApp();
    const body = (
      await acquire(app, { name: 'alice', spec: { cpus: 2 } })
    ).json();
    expect(body.sandbox.spec).toEqual({ cpus: 2, memoryGb: 2, diskGb: 10 });
    // The unnamed knobs stay NULL — still following the fleet-wide knob.
    const row = findByName(db, 'alice');
    expect(row?.cpus).toBe(2);
    expect(row?.memoryGb).toBeNull();
    expect(row?.diskGb).toBeNull();
  });

  it('an existing sandbox keeps its stored spec — acquire is not an update verb', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice', spec: { cpus: 2 } });
    const second = (
      await acquire(app, { name: 'alice', spec: { cpus: 8, diskGb: 99 } })
    ).json();
    expect(second.created).toBe(false);
    expect(second.sandbox.spec).toEqual({ cpus: 2, memoryGb: 2, diskGb: 10 });
  });

  it('an invalid spec is a 400, never silently ignored', async () => {
    const { app } = testApp();
    const res = await acquire(app, { name: 'alice', spec: { cpus: -1 } });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /updateSpec', () => {
  it('patches the stored CPU/memory knobs and records the change', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice' });
    const before = (await rpc(app, '/listSandboxes')).json().sandboxes[0];
    const res = await rpc(app, '/updateSpec', {
      name: 'alice',
      spec: { cpus: 2, memoryGb: 4 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sandbox.spec).toEqual({
      cpus: 2,
      memoryGb: 4,
      diskGb: 10,
    });
    // A pure ledger write: state untouched, idle clock NOT refreshed.
    expect(res.json().sandbox.state).toBe('active');
    expect(res.json().sandbox.lastActiveAt).toBe(before.lastActiveAt);
    expect(await activityKinds(app)).toContain('spec-changed');
  });

  it('omitted knobs keep their values; null pins back to the global default', async () => {
    const { app, db } = testApp();
    await acquire(app, { name: 'alice', spec: { cpus: 2, memoryGb: 4 } });
    const patched = (
      await rpc(app, '/updateSpec', { name: 'alice', spec: { cpus: null } })
    ).json();
    // cpus re-follows the default (1); memoryGb kept its pinned 4.
    expect(patched.sandbox.spec).toEqual({ cpus: 1, memoryGb: 4, diskGb: 10 });
    expect(findByName(db, 'alice')?.cpus).toBeNull();
  });

  it('a no-op patch writes no history', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice', spec: { cpus: 2 } });
    await rpc(app, '/updateSpec', { name: 'alice', spec: { cpus: 2 } });
    expect(await activityKinds(app)).not.toContain('spec-changed');
  });

  it('answers 404 for an unknown key — updateSpec is not a creator', async () => {
    const res = await rpc(testApp().app, '/updateSpec', {
      name: 'ghost',
      spec: { cpus: 2 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('an empty spec patch is a caller confusion, 400', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice' });
    const res = await rpc(app, '/updateSpec', { name: 'alice', spec: {} });
    expect(res.statusCode).toBe(400);
  });

  it('the next cold wake swaps the shell onto the new limits; a matching shell keeps the fast path', async () => {
    const { app, db, executor, locks } = testApp();
    const created = (
      await acquire(app, { name: 'alice', policy: { freezeAfterSeconds: 1 } })
    ).json();
    const id = created.sandbox.id;
    await rpc(app, '/updateSpec', { name: 'alice', spec: { cpus: 2 } });

    // Freeze by idleness, then wake by acquire: the frozen fast path must
    // yield to the spec convergence — rebuild, cold start, new limits.
    const { lastActiveAt } = (await rpc(app, '/listSandboxes')).json()
      .sandboxes[0];
    await scanOnce(db, executor, locks, after(lastActiveAt, 1));
    expect(executor.stateOf(id)).toBe('paused');
    const woken = (await acquire(app, { name: 'alice' })).json();
    expect(woken.sandbox.state).toBe('active');
    expect(await executor.limitsOf(id)).toEqual({
      nanoCpus: 2e9,
      memoryBytes: 2 * 1024 ** 3,
    });
    expect(await activityKinds(app)).toContain('rebuilt');

    // Freeze again with the spec unchanged: the wake must NOT rebuild —
    // the millisecond unpause path stays untouched.
    const again = (await rpc(app, '/listSandboxes')).json().sandboxes[0];
    await scanOnce(db, executor, locks, after(again.lastActiveAt, 1));
    await acquire(app, { name: 'alice' });
    const rebuilds = (await activityKinds(app)).filter(
      (kind) => kind === 'rebuilt',
    );
    expect(rebuilds).toHaveLength(1);
  });
});

describe('POST /expandDisk', () => {
  it('grows the disk synchronously and pins the new size', async () => {
    const { app, executor } = testApp();
    const created = (await acquire(app, { name: 'alice' })).json();
    const res = await rpc(app, '/expandDisk', { name: 'alice', diskGb: 20 });
    expect(res.statusCode).toBe(200);
    expect(res.json().sandbox.spec.diskGb).toBe(20);
    expect((await executor.metrics(created.sandbox.id)).diskTotalBytes).toBe(
      20 * 1024 ** 3,
    );
    expect(await activityKinds(app)).toContain('disk-expanded');
  });

  it('refuses to shrink with a 400', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice' });
    const res = await rpc(app, '/expandDisk', { name: 'alice', diskGb: 5 });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/only grows/);
  });

  it('asking for the pinned size again is a no-op success, no history', async () => {
    const { app } = testApp();
    await acquire(app, { name: 'alice' });
    await rpc(app, '/expandDisk', { name: 'alice', diskGb: 20 });
    const res = await rpc(app, '/expandDisk', { name: 'alice', diskGb: 20 });
    expect(res.statusCode).toBe(200);
    expect(res.json().sandbox.spec.diskGb).toBe(20);
    const expansions = (await activityKinds(app)).filter(
      (kind) => kind === 'disk-expanded',
    );
    expect(expansions).toHaveLength(1);
  });

  it('asking for the default size on an unpinned row pins it', async () => {
    const { app, db } = testApp();
    await acquire(app, { name: 'alice' });
    expect(findByName(db, 'alice')?.diskGb).toBeNull();
    const res = await rpc(app, '/expandDisk', { name: 'alice', diskGb: 10 });
    expect(res.statusCode).toBe(200);
    // Pinned: a later cut to the global default cannot shrink this
    // sandbox's entitlement on paper.
    expect(findByName(db, 'alice')?.diskGb).toBe(10);
  });

  it('answers 404 for an unknown key — expandDisk is not a creator', async () => {
    const res = await rpc(testApp().app, '/expandDisk', {
      name: 'ghost',
      diskGb: 20,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('spec through the archive', () => {
  /** app.test.ts's poll loop: acquire until the restore lands on ready. */
  async function acquireUntilReady(
    app: ReturnType<typeof testApp>['app'],
    name: string,
  ) {
    const deadline = Date.now() + 5_000;
    while (true) {
      const body = (await acquire(app, { name })).json();
      if (body.status === 'ready') return body;
      expect(body.status).toBe('restoring');
      if (Date.now() > deadline) {
        throw new Error(`still restoring: ${JSON.stringify(body)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('expandDisk on an archived sandbox moves ledger-only; the restore opens the disk at the recorded size', async () => {
    const { app, db, executor, locks, archiver } = archiverTestApp();
    const created = (
      await acquire(app, {
        name: 'alice',
        policy: {
          freezeAfterSeconds: 1,
          stopAfterSeconds: 2,
          archiveAfterSeconds: 3,
        },
      })
    ).json();
    const id = created.sandbox.id;
    await rpc(app, '/writeFiles', {
      name: 'alice',
      files: [
        {
          path: 'kept.txt',
          contentBase64: Buffer.from('sized right').toString('base64'),
        },
      ],
    });
    const { lastActiveAt } = (await rpc(app, '/listSandboxes')).json()
      .sandboxes[0];
    await scanOnce(db, executor, locks, after(lastActiveAt, 1), archiver);
    await scanOnce(db, executor, locks, after(lastActiveAt, 2), archiver);
    await scanOnce(db, executor, locks, after(lastActiveAt, 3), archiver);
    expect((await rpc(app, '/listSandboxes')).json().sandboxes[0].state).toBe(
      'archived',
    );

    // No local disk exists; only the ledger moves.
    const res = await rpc(app, '/expandDisk', { name: 'alice', diskGb: 20 });
    expect(res.statusCode).toBe(200);
    expect(res.json().sandbox.spec.diskGb).toBe(20);

    // The restore provisions the fresh disk at the recorded 20 GiB.
    const ready = await acquireUntilReady(app, 'alice');
    expect(ready.sandbox.id).toBe(id);
    expect((await executor.metrics(id)).diskTotalBytes).toBe(20 * 1024 ** 3);
    const read = (
      await rpc(app, '/readFile', { name: 'alice', path: 'kept.txt' })
    ).json();
    expect(Buffer.from(read.contentBase64, 'base64').toString()).toBe(
      'sized right',
    );
  });
});

describe('the E2B surface reports the per-sandbox spec', () => {
  it('getInfo resolves the sandbox row, not the global defaults', async () => {
    const { app } = testApp();
    const created = (
      await acquire(app, {
        name: 'alice',
        spec: { cpus: 2, memoryGb: 4, diskGb: 20 },
      })
    ).json();
    const info = await app.inject({
      method: 'GET',
      url: `/e2b/api/sandboxes/${created.sandbox.id}`,
      headers: { 'x-api-key': TOKEN },
    });
    expect(info.statusCode).toBe(200);
    expect(info.json().cpuCount).toBe(2);
    expect(info.json().memoryMB).toBe(4096);
    expect(info.json().diskSizeMB).toBe(20480);
  });
});
