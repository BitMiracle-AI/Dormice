import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ActivityEvent,
  type ConfigEntry,
  getConfigResponseSchema,
  getSandboxMetricsResponseSchema,
  listActivityResponseSchema,
  listSandboxMetricsResponseSchema,
} from '@dormice/shared';
import { count } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { Archiver } from '../archive/archiver';
import { MemStore } from '../archive/mem-store';
import { CONFIG_KEYS, type ConfigSources, loadConfig } from '../config';
import { ACTIVITY_KEEP, recordActivity } from '../db/activity';
import { migrateDb, openDb } from '../db/db';
import { activity } from '../db/schema';
import { FakeExecutor } from '../executor/fake';
import { KeyedQueue } from '../keyed-queue';
import { freezeSandbox, stopSandbox } from '../lifecycle';
import { ARCHIVE_DEFAULT_SECONDS } from '../policy';
import { reconcile } from '../reconciler';
import { scanOnce } from '../scanner';

// The three observability verbs, app-level: getConfig, listActivity,
// getSandboxMetrics — the console's food, so the tests eat exactly what a
// browser would.

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const TOKEN = 'test-token-test-token-test-token';
const authed = { authorization: `Bearer ${TOKEN}` };

/** All-defaults source map; tests override the keys they assert on. */
function fixedSources(overrides: Partial<ConfigSources> = {}): ConfigSources {
  const all = Object.fromEntries(
    Object.keys(CONFIG_KEYS).map((key) => [key, 'default']),
  ) as ConfigSources;
  return { ...all, ...overrides, DORMICE_API_TOKEN: 'env' };
}

function testApp(env: Record<string, string> = {}) {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const config = loadConfig({
    DORMICE_DB_PATH: ':memory:',
    DORMICE_NODE_ID: 'node-test',
    DORMICE_API_TOKEN: TOKEN,
    ...env,
  });
  const executor = new FakeExecutor();
  const locks = new KeyedQueue();
  const sources = fixedSources(
    Object.fromEntries(
      Object.keys(env).map((key) => [key, 'env']),
    ) as Partial<ConfigSources>,
  );
  const app = buildApp({ config, db, executor, locks, logger: false, sources });
  return { app, db, executor, locks };
}

type App = ReturnType<typeof testApp>['app'];

function rpc(app: App, url: string, payload: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url, headers: authed, payload });
}

async function events(app: App): Promise<ActivityEvent[]> {
  const res = await rpc(app, '/listActivity');
  expect(res.statusCode).toBe(200);
  return listActivityResponseSchema.parse(res.json()).events;
}

describe('getConfig', () => {
  it('reports every knob with value and source, and validates', async () => {
    const { app } = testApp({ DORMICE_MAX_SANDBOXES: '7' });
    const res = await rpc(app, '/getConfig');
    expect(res.statusCode).toBe(200);
    const body = getConfigResponseSchema.parse(res.json());

    const byKey = new Map(body.entries.map((e: ConfigEntry) => [e.key, e]));
    // Complete: one entry per knob the config schema knows.
    expect(body.entries).toHaveLength(Object.keys(CONFIG_KEYS).length);
    expect(byKey.get('DORMICE_MAX_SANDBOXES')).toMatchObject({
      value: '7',
      source: 'env',
    });
    expect(byKey.get('DORMICE_PORT')).toMatchObject({
      value: '3676',
      source: 'default',
    });
    // Optional and unset: honestly null, not invented.
    expect(byKey.get('DORMICE_SANDBOX_DOMAIN')).toMatchObject({ value: null });
  });

  it('withholds secrets, reporting only their presence', async () => {
    const { app } = testApp();
    const body = getConfigResponseSchema.parse(
      (await rpc(app, '/getConfig')).json(),
    );
    const token = body.entries.find(
      (e: ConfigEntry) => e.key === 'DORMICE_API_TOKEN',
    );
    expect(token).toMatchObject({ value: null, redacted: true });
    // The raw token must appear nowhere in the whole response.
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('adjudicates archive availability: off without an archiver', async () => {
    const { app } = testApp();
    const body = getConfigResponseSchema.parse(
      (await rpc(app, '/getConfig')).json(),
    );
    expect(body.archive).toEqual({ enabled: false, defaultSeconds: null });
  });

  it('reports the archive default when an archiver is wired', async () => {
    // buildApp derives the default purely from the archiver's presence.
    const db = openDb(':memory:');
    migrateDb(db, MIGRATIONS);
    const executor = new FakeExecutor();
    const locks = new KeyedQueue();
    const config = loadConfig({
      DORMICE_DB_PATH: ':memory:',
      DORMICE_API_TOKEN: TOKEN,
    });
    const archiver = new Archiver({
      db,
      executor,
      locks,
      store: new MemStore(),
      tmpDir: mkdtempSync(path.join(tmpdir(), 'dormice-obs-')),
    });
    const app = buildApp({
      config,
      db,
      executor,
      locks,
      logger: false,
      sources: fixedSources(),
      archiver,
    });
    const body = getConfigResponseSchema.parse(
      (await rpc(app, '/getConfig')).json(),
    );
    expect(body.archive).toEqual({
      enabled: true,
      defaultSeconds: ARCHIVE_DEFAULT_SECONDS,
    });
  });
});

describe('listActivity', () => {
  it('records create, wake, cooling and release, newest first', async () => {
    const { app, db, executor, locks } = testApp();
    const res = await rpc(app, '/acquireSandbox', {
      userKey: 'story',
      policy: { freezeAfterSeconds: 5, stopAfterSeconds: 10 },
    });
    expect(res.statusCode).toBe(200);
    const created = res.json().sandbox;

    // Cool it two rungs by time travel, then wake it back through acquire.
    await scanOnce(
      db,
      executor,
      locks,
      new Date(Date.parse(created.lastActiveAt) + 6_000),
    );
    await scanOnce(
      db,
      executor,
      locks,
      new Date(Date.parse(created.lastActiveAt) + 11_000),
    );
    await rpc(app, '/acquireSandbox', { userKey: 'story' });
    await rpc(app, '/releaseSandbox', { userKey: 'story' });

    const log = await events(app);
    expect(log.map((e) => e.kind)).toEqual([
      'released',
      'woken',
      'stopped',
      'frozen',
      'created',
    ]);
    // Every event names its sandbox, and the scanner names its threshold.
    expect(new Set(log.map((e) => e.userKey))).toEqual(new Set(['story']));
    expect(log.find((e) => e.kind === 'frozen')?.detail).toContain('scanner');
    expect(log.find((e) => e.kind === 'created')?.detail).toContain(
      'acquireSandbox',
    );
  });

  it('records what reconciliation repaired', async () => {
    const { app, db, executor, locks } = testApp();
    await rpc(app, '/acquireSandbox', { userKey: 'doomed' });
    const { sandboxes } = (await rpc(app, '/listSandboxes')).json();
    // Reality loses both container and disk behind the ledger's back.
    await executor.destroy(sandboxes[0].sandboxId);
    await reconcile(db, executor, locks);

    const log = await events(app);
    expect(log[0]).toMatchObject({ kind: 'reconciled', userKey: 'doomed' });
    expect(log[0]?.detail).toContain('row deleted');
  });

  it('honors the limit and keeps the ring bounded', async () => {
    const { app, db } = testApp();
    for (let i = 0; i < ACTIVITY_KEEP + 50; i += 1) {
      recordActivity(db, { kind: 'daemon-started', detail: `tick ${i}` });
    }
    const page = listActivityResponseSchema.parse(
      (await rpc(app, '/listActivity', { limit: 3 })).json(),
    ).events;
    expect(page).toHaveLength(3);
    expect(page[0]?.detail).toBe(`tick ${ACTIVITY_KEEP + 49}`);

    // The bound must live in the TABLE, not in the page clamp: a missing
    // prune with limit=1000 would return the same page — count the rows.
    const total = db.select({ n: count() }).from(activity).get() as {
      n: number;
    };
    expect(total.n).toBe(ACTIVITY_KEEP);
    const all = listActivityResponseSchema.parse(
      (await rpc(app, '/listActivity', { limit: 1000 })).json(),
    ).events;
    // The oldest 50 fell off the ring.
    expect(all.at(-1)?.detail).toBe('tick 50');
  });

  it('rejects an out-of-range limit', async () => {
    const { app } = testApp();
    const res = await rpc(app, '/listActivity', { limit: 0 });
    expect(res.statusCode).toBe(400);
  });
});

describe('getSandboxMetrics', () => {
  it('answers a single sample for a running sandbox', async () => {
    const { app } = testApp();
    await rpc(app, '/acquireSandbox', { userKey: 'measured' });
    const res = await rpc(app, '/getSandboxMetrics', { userKey: 'measured' });
    expect(res.statusCode).toBe(200);
    const { sample } = getSandboxMetricsResponseSchema.parse(res.json());
    expect(sample).not.toBeNull();
    expect(sample?.memTotalBytes).toBeGreaterThan(0);
    expect(sample?.diskTotalBytes).toBeGreaterThan(0);
  });

  it('answers null for a stopped sandbox instead of waking it', async () => {
    const { app, db, executor } = testApp();
    const res = await rpc(app, '/acquireSandbox', { userKey: 'cold' });
    const { sandboxId } = res.json().sandbox;
    await freezeSandbox(db, executor, sandboxId);
    await stopSandbox(db, executor, sandboxId);

    const metrics = await rpc(app, '/getSandboxMetrics', { userKey: 'cold' });
    expect(getSandboxMetricsResponseSchema.parse(metrics.json()).sample).toBe(
      null,
    );
    // Observation is not activity: still stopped afterwards.
    const { sandboxes } = (await rpc(app, '/listSandboxes')).json();
    expect(sandboxes[0].state).toBe('stopped');
  });

  it('404s an unknown key instead of inventing a sandbox', async () => {
    const { app } = testApp();
    const res = await rpc(app, '/getSandboxMetrics', { userKey: 'nobody' });
    expect(res.statusCode).toBe(404);
  });
});

describe('listSandboxMetrics', () => {
  it('measures active and frozen sandboxes; colder states are absent', async () => {
    const { app, db, executor } = testApp();
    await rpc(app, '/acquireSandbox', { userKey: 'hot' });
    const frozen = await rpc(app, '/acquireSandbox', { userKey: 'napping' });
    await freezeSandbox(db, executor, frozen.json().sandbox.sandboxId);
    const cold = await rpc(app, '/acquireSandbox', { userKey: 'cold' });
    const coldId = cold.json().sandbox.sandboxId;
    await freezeSandbox(db, executor, coldId);
    await stopSandbox(db, executor, coldId);

    const res = await rpc(app, '/listSandboxMetrics', {});
    expect(res.statusCode).toBe(200);
    const { samples } = listSandboxMetricsResponseSchema.parse(res.json());
    const keys = samples.map((s) => s.userKey).sort();
    // The frozen sandbox is measured as it sleeps; the stopped one has no
    // container to measure and is honestly absent, not null-stuffed.
    expect(keys).toEqual(['hot', 'napping']);
    for (const entry of samples) {
      expect(entry.sample.memTotalBytes).toBeGreaterThan(0);
      expect(entry.sample.diskTotalBytes).toBeGreaterThan(0);
    }
    // Observation is not activity: nobody woke or cooled further.
    const { sandboxes } = (await rpc(app, '/listSandboxes')).json();
    const byKey = new Map<string, string>(
      sandboxes.map((s: { userKey: string; state: string }) => [
        s.userKey,
        s.state,
      ]),
    );
    expect(byKey.get('napping')).toBe('frozen');
    expect(byKey.get('cold')).toBe('stopped');
  });

  it('skips a sandbox whose container vanished instead of failing the sweep', async () => {
    const { app, executor } = testApp();
    await rpc(app, '/acquireSandbox', { userKey: 'alive' });
    const doomed = await rpc(app, '/acquireSandbox', { userKey: 'doomed' });
    // The container dies physically, past the ledger (gVisor OOM does this
    // for real) — the row still says active, the reading throws, the sweep
    // reports what it could see.
    const doomedId = doomed.json().sandbox.sandboxId;
    await executor.freeze(doomedId);
    await executor.stop(doomedId);

    const res = await rpc(app, '/listSandboxMetrics', {});
    const { samples } = listSandboxMetricsResponseSchema.parse(res.json());
    expect(samples.map((s) => s.userKey)).toEqual(['alive']);
  });

  it('answers an empty list on an empty ledger', async () => {
    const { app } = testApp();
    const res = await rpc(app, '/listSandboxMetrics', {});
    expect(listSandboxMetricsResponseSchema.parse(res.json()).samples).toEqual(
      [],
    );
  });
});
