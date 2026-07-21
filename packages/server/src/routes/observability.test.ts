import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ActivityEvent,
  type ConfigEntry,
  getConfigResponseSchema,
  getFleetTimelineResponseSchema,
  getHostMetricsHistoryResponseSchema,
  getSandboxMetricsHistoryResponseSchema,
  getSandboxMetricsResponseSchema,
  listActivityResponseSchema,
  listSandboxImagesResponseSchema,
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
import { insertMetricsTick, MAX_POINTS } from '../db/metrics';
import { activity } from '../db/schema';
import { FAKE_BASE_IMAGE, FakeExecutor } from '../executor/fake';
import { CpuSampler, type HostSample } from '../host-metrics';
import { KeyedQueue } from '../keyed-queue';
import { freezeSandbox, stopSandbox } from '../lifecycle';
import { sampleOnce } from '../metrics-sampler';
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

// One tick's non-sandbox inputs. A fresh CpuSampler per call is fine: its
// delta-less first reading is an honest null; the data dir doesn't exist,
// so disk is null too.
function tickOpts() {
  return {
    retentionHours: 168,
    hostCpu: new CpuSampler(),
    dataDir: '/nowhere/dormice-observability-test',
  };
}

// A fixed host reading for straight-to-the-writer tests; hostReading(cpu)
// varies the one field the history assertions care about.
const HOST: HostSample = hostReading(12);

function hostReading(cpuUsedPct: number | null): HostSample {
  return {
    cpuUsedPct,
    memTotalBytes: 4096,
    memAvailableBytes: 2048,
    swapTotalBytes: 1024,
    swapUsedBytes: 256,
    diskTotalBytes: null,
    diskUsedBytes: null,
    diskAvailableBytes: null,
  };
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
      name: 'story',
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
    await rpc(app, '/acquireSandbox', { name: 'story' });
    await rpc(app, '/destroySandbox', { name: 'story' });

    const log = await events(app);
    expect(log.map((e) => e.kind)).toEqual([
      'destroyed',
      'woken',
      'stopped',
      'frozen',
      'created',
    ]);
    // Every event names its sandbox, and the scanner names its threshold.
    expect(new Set(log.map((e) => e.sandboxName))).toEqual(new Set(['story']));
    expect(log.find((e) => e.kind === 'frozen')?.detail).toContain('scanner');
    expect(log.find((e) => e.kind === 'created')?.detail).toContain(
      'acquireSandbox',
    );
  });

  it('records what reconciliation repaired', async () => {
    const { app, db, executor, locks } = testApp();
    await rpc(app, '/acquireSandbox', { name: 'doomed' });
    const { sandboxes } = (await rpc(app, '/listSandboxes')).json();
    // Reality loses both container and disk behind the ledger's back.
    await executor.destroy(sandboxes[0].id);
    await reconcile(db, executor, locks);

    const log = await events(app);
    expect(log[0]).toMatchObject({ kind: 'reconciled', sandboxName: 'doomed' });
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
    await rpc(app, '/acquireSandbox', { name: 'measured' });
    const res = await rpc(app, '/getSandboxMetrics', {
      name: 'measured',
    });
    expect(res.statusCode).toBe(200);
    const { sample } = getSandboxMetricsResponseSchema.parse(res.json());
    expect(sample).not.toBeNull();
    expect(sample?.memTotalBytes).toBeGreaterThan(0);
    expect(sample?.diskTotalBytes).toBeGreaterThan(0);
  });

  it('answers null for a stopped sandbox instead of waking it', async () => {
    const { app, db, executor } = testApp();
    const res = await rpc(app, '/acquireSandbox', { name: 'cold' });
    const { id: sandboxId } = res.json().sandbox;
    await freezeSandbox(db, executor, sandboxId);
    await stopSandbox(db, executor, sandboxId);

    const metrics = await rpc(app, '/getSandboxMetrics', {
      name: 'cold',
    });
    expect(getSandboxMetricsResponseSchema.parse(metrics.json()).sample).toBe(
      null,
    );
    // Observation is not activity: still stopped afterwards.
    const { sandboxes } = (await rpc(app, '/listSandboxes')).json();
    expect(sandboxes[0].state).toBe('stopped');
  });

  it('404s an unknown key instead of inventing a sandbox', async () => {
    const { app } = testApp();
    const res = await rpc(app, '/getSandboxMetrics', { name: 'nobody' });
    expect(res.statusCode).toBe(404);
  });
});

describe('getSandboxMetricsHistory', () => {
  /** Crafted metrics; only the fields under test vary. */
  function reading(cpuUsedPct = 10) {
    return {
      cpuCount: 1,
      cpuUsedPct,
      memUsedBytes: 64,
      memTotalBytes: 2048,
      memCacheBytes: 0,
      diskUsedBytes: 10,
      diskTotalBytes: 100,
    };
  }

  it('404s an unknown key instead of inventing a sandbox', async () => {
    const { app } = testApp();
    const res = await rpc(app, '/getSandboxMetricsHistory', {
      name: 'nobody',
    });
    expect(res.statusCode).toBe(404);
  });

  it('answers an empty window honestly — never a live fallback', async () => {
    const { app } = testApp();
    await rpc(app, '/acquireSandbox', { name: 'fresh' });
    // The sandbox is running and measurable, but the sampler never ticked:
    // the native face reports silence as silence (the E2B face is the one
    // that takes a live reading, as compatibility politeness).
    const res = await rpc(app, '/getSandboxMetricsHistory', {
      name: 'fresh',
    });
    expect(res.statusCode).toBe(200);
    const body = getSandboxMetricsHistoryResponseSchema.parse(res.json());
    expect(body).toEqual({ samples: [], bucketSeconds: null });
  });

  it('rejects an unparseable timestamp at the door', async () => {
    const { app } = testApp();
    await rpc(app, '/acquireSandbox', { name: 'strict' });
    const res = await rpc(app, '/getSandboxMetricsHistory', {
      name: 'strict',
      start: 'yesterday-ish',
    });
    expect(res.statusCode).toBe(400);
  });

  it('slices by start/end, ascending', async () => {
    const { app, db, executor } = testApp();
    await rpc(app, '/acquireSandbox', { name: 'sliced' });
    const t0 = Date.parse('2026-07-15T10:00:00.000Z');
    for (let i = 0; i < 3; i += 1) {
      await sampleOnce(db, executor, new Date(t0 + i * 30_000), tickOpts());
    }
    const res = await rpc(app, '/getSandboxMetricsHistory', {
      name: 'sliced',
      start: new Date(t0 + 15_000).toISOString(),
      end: new Date(t0 + 65_000).toISOString(),
    });
    const { samples, bucketSeconds } =
      getSandboxMetricsHistoryResponseSchema.parse(res.json());
    expect(bucketSeconds).toBe(null);
    expect(samples.map((s) => s.timestamp)).toEqual([
      new Date(t0 + 30_000).toISOString(),
      new Date(t0 + 60_000).toISOString(),
    ]);
  });

  it('buckets past MAX_POINTS by per-field max — the spike survives', async () => {
    const { app, db } = testApp();
    const created = (
      await rpc(app, '/acquireSandbox', { name: 'spiky' })
    ).json().sandbox;
    const t0 = Date.parse('2026-07-15T00:00:00.000Z');
    const rows = MAX_POINTS + 40;
    for (let i = 0; i < rows; i += 1) {
      insertMetricsTick(db, {
        at: new Date(t0 + i * 30_000).toISOString(),
        host: HOST,
        fleetCounts: {
          active: 1,
          frozen: 0,
          stopped: 0,
          archived: 0,
          restoring: 0,
          total: 1,
        },
        // One reading spikes; every neighbor idles. Averaging would bury it.
        samples: [
          {
            sandboxId: created.id,
            metrics: reading(i === 200 ? 95 : 5),
          },
        ],
        retentionHours: 168,
      });
    }
    const res = await rpc(app, '/getSandboxMetricsHistory', {
      name: 'spiky',
      start: new Date(t0).toISOString(),
      end: new Date(t0 + rows * 30_000).toISOString(),
    });
    const { samples, bucketSeconds } =
      getSandboxMetricsHistoryResponseSchema.parse(res.json());
    expect(bucketSeconds).not.toBe(null);
    expect(samples.length).toBeLessThanOrEqual(MAX_POINTS);
    // Ascending, and the bucket holding the spike reports the spike.
    const times = samples.map((s) => Date.parse(s.timestamp));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(Math.max(...samples.map((s) => s.cpuUsedPct))).toBe(95);
  });
});

describe('getFleetTimeline', () => {
  it('answers an empty window with no points and a null peak', async () => {
    const { app } = testApp();
    const res = await rpc(app, '/getFleetTimeline', {});
    expect(res.statusCode).toBe(200);
    const body = getFleetTimelineResponseSchema.parse(res.json());
    expect(body).toEqual({ points: [], bucketSeconds: null, peak: null });
  });

  it('returns snapshots ascending with byState summing to total', async () => {
    const { app, db, executor } = testApp();
    await rpc(app, '/acquireSandbox', { name: 'one' });
    const t0 = Date.parse('2026-07-15T10:00:00.000Z');
    await sampleOnce(db, executor, new Date(t0), tickOpts());
    await rpc(app, '/acquireSandbox', { name: 'two' });
    await sampleOnce(db, executor, new Date(t0 + 30_000), tickOpts());

    const res = await rpc(app, '/getFleetTimeline', {
      start: new Date(t0 - 1000).toISOString(),
      end: new Date(t0 + 60_000).toISOString(),
    });
    const { points, bucketSeconds, peak } =
      getFleetTimelineResponseSchema.parse(res.json());
    expect(bucketSeconds).toBe(null);
    expect(points.map((p) => p.at)).toEqual([
      new Date(t0).toISOString(),
      new Date(t0 + 30_000).toISOString(),
    ]);
    for (const point of points) {
      const sum = Object.values(point.byState).reduce((a, b) => a + b, 0);
      expect(sum).toBe(point.total);
    }
    expect(peak).toEqual({
      active: 2,
      at: new Date(t0 + 30_000).toISOString(),
    });
  });

  it('computes the peak from raw rows — bucketing cannot flatten it', async () => {
    const { app, db } = testApp();
    const t0 = Date.parse('2026-07-15T00:00:00.000Z');
    const counts = (active: number) => ({
      active,
      frozen: 0,
      stopped: 0,
      archived: 0,
      restoring: 0,
      total: active,
    });
    const rows = MAX_POINTS + 40;
    for (let i = 0; i < rows; i += 1) {
      insertMetricsTick(db, {
        at: new Date(t0 + i * 30_000).toISOString(),
        host: HOST,
        fleetCounts: counts(1),
        samples: [],
        retentionHours: 168,
      });
    }
    // A spike squeezed between two grid rows of its own bucket: the bucket
    // keeps its LAST whole snapshot, so no point ever shows 9 — the peak
    // field is the only honest carrier.
    insertMetricsTick(db, {
      at: new Date(t0 + 200 * 30_000 + 1000).toISOString(),
      host: HOST,
      fleetCounts: counts(9),
      samples: [],
      retentionHours: 168,
    });
    insertMetricsTick(db, {
      at: new Date(t0 + 200 * 30_000 + 2000).toISOString(),
      host: HOST,
      fleetCounts: counts(1),
      samples: [],
      retentionHours: 168,
    });

    const res = await rpc(app, '/getFleetTimeline', {
      start: new Date(t0).toISOString(),
      end: new Date(t0 + rows * 30_000).toISOString(),
    });
    const { points, bucketSeconds, peak } =
      getFleetTimelineResponseSchema.parse(res.json());
    expect(bucketSeconds).not.toBe(null);
    expect(points.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(peak).toEqual({
      active: 9,
      at: new Date(t0 + 200 * 30_000 + 1000).toISOString(),
    });
    // Whole-snapshot buckets: sums still hold after bucketing.
    for (const point of points) {
      const sum = Object.values(point.byState).reduce((a, b) => a + b, 0);
      expect(sum).toBe(point.total);
    }
  });
});

describe('getHostMetricsHistory', () => {
  it('answers an empty window with no points and a null peak', async () => {
    const { app } = testApp();
    const res = await rpc(app, '/getHostMetricsHistory', {});
    expect(res.statusCode).toBe(200);
    const body = getHostMetricsHistoryResponseSchema.parse(res.json());
    expect(body).toEqual({ points: [], bucketSeconds: null, peak: null });
  });

  it('rejects an unparseable timestamp at the door', async () => {
    const { app } = testApp();
    const res = await rpc(app, '/getHostMetricsHistory', {
      start: 'yesterday-ish',
    });
    expect(res.statusCode).toBe(400);
  });

  it('slices ascending with real readings, nulls staying honest', async () => {
    const { app, db, executor } = testApp();
    const t0 = Date.parse('2026-07-15T10:00:00.000Z');
    for (let i = 0; i < 3; i += 1) {
      await sampleOnce(db, executor, new Date(t0 + i * 30_000), tickOpts());
    }
    const res = await rpc(app, '/getHostMetricsHistory', {
      start: new Date(t0 + 15_000).toISOString(),
      end: new Date(t0 + 65_000).toISOString(),
    });
    const { points, bucketSeconds } = getHostMetricsHistoryResponseSchema.parse(
      res.json(),
    );
    expect(bucketSeconds).toBe(null);
    expect(points.map((p) => p.at)).toEqual([
      new Date(t0 + 30_000).toISOString(),
      new Date(t0 + 60_000).toISOString(),
    ]);
    for (const point of points) {
      // Real memory from this very machine; honest nulls for the missing
      // data dir and the CPU delta a fresh sampler doesn't have.
      expect(point.memTotalBytes).toBeGreaterThan(0);
      expect(point.memAvailableBytes).toBeGreaterThan(0);
      expect(point.dataDisk).toBe(null);
      expect(point.cpuUsedPct).toBe(null);
    }
  });

  it('buckets by per-field worst case and carries the CPU peak raw', async () => {
    const { app, db } = testApp();
    const t0 = Date.parse('2026-07-15T00:00:00.000Z');
    const rows = MAX_POINTS + 40;
    for (let i = 0; i < rows; i += 1) {
      insertMetricsTick(db, {
        at: new Date(t0 + i * 30_000).toISOString(),
        // One reading spikes; every neighbor idles. Averaging would bury it.
        host: hostReading(i === 200 ? 95 : 5),
        fleetCounts: {
          active: 0,
          frozen: 0,
          stopped: 0,
          archived: 0,
          restoring: 0,
          total: 0,
        },
        samples: [],
        retentionHours: 168,
      });
    }
    const res = await rpc(app, '/getHostMetricsHistory', {
      start: new Date(t0).toISOString(),
      end: new Date(t0 + rows * 30_000).toISOString(),
    });
    const { points, bucketSeconds, peak } =
      getHostMetricsHistoryResponseSchema.parse(res.json());
    expect(bucketSeconds).not.toBe(null);
    expect(points.length).toBeLessThanOrEqual(MAX_POINTS);
    // Ascending, and the bucket holding the spike reports the spike.
    const times = points.map((p) => Date.parse(p.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(Math.max(...points.map((p) => p.cpuUsedPct ?? 0))).toBe(95);
    // The peak is computed from raw rows, at the raw instant — not the
    // bucket's synthetic start.
    expect(peak).toEqual({
      cpuUsedPct: 95,
      at: new Date(t0 + 200 * 30_000).toISOString(),
    });
  });

  it('a null-CPU tick never competes for the peak', async () => {
    const { app, db } = testApp();
    const t0 = Date.parse('2026-07-15T10:00:00.000Z');
    const counts = {
      active: 0,
      frozen: 0,
      stopped: 0,
      archived: 0,
      restoring: 0,
      total: 0,
    };
    insertMetricsTick(db, {
      at: new Date(t0).toISOString(),
      host: hostReading(null),
      fleetCounts: counts,
      samples: [],
      retentionHours: 168,
    });
    insertMetricsTick(db, {
      at: new Date(t0 + 30_000).toISOString(),
      host: hostReading(40),
      fleetCounts: counts,
      samples: [],
      retentionHours: 168,
    });
    const res = await rpc(app, '/getHostMetricsHistory', {
      start: new Date(t0).toISOString(),
      end: new Date(t0 + 60_000).toISOString(),
    });
    const { points, peak } = getHostMetricsHistoryResponseSchema.parse(
      res.json(),
    );
    expect(points).toHaveLength(2);
    expect(peak).toEqual({
      cpuUsedPct: 40,
      at: new Date(t0 + 30_000).toISOString(),
    });
  });
});

describe('listSandboxMetrics', () => {
  it('measures active and frozen sandboxes; colder states are absent', async () => {
    const { app, db, executor } = testApp();
    await rpc(app, '/acquireSandbox', { name: 'hot' });
    const frozen = await rpc(app, '/acquireSandbox', { name: 'napping' });
    await freezeSandbox(db, executor, frozen.json().sandbox.id);
    const cold = await rpc(app, '/acquireSandbox', { name: 'cold' });
    const coldId = cold.json().sandbox.id;
    await freezeSandbox(db, executor, coldId);
    await stopSandbox(db, executor, coldId);

    const res = await rpc(app, '/listSandboxMetrics', {});
    expect(res.statusCode).toBe(200);
    const { samples } = listSandboxMetricsResponseSchema.parse(res.json());
    const keys = samples.map((s) => s.sandboxName).sort();
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
      sandboxes.map((s: { name: string; state: string }) => [s.name, s.state]),
    );
    expect(byKey.get('napping')).toBe('frozen');
    expect(byKey.get('cold')).toBe('stopped');
  });

  it('skips a sandbox whose container vanished instead of failing the sweep', async () => {
    const { app, executor } = testApp();
    await rpc(app, '/acquireSandbox', { name: 'alive' });
    const doomed = await rpc(app, '/acquireSandbox', { name: 'doomed' });
    // The container dies physically, past the ledger (gVisor OOM does this
    // for real) — the row still says active, the reading throws, the sweep
    // reports what it could see.
    const doomedId = doomed.json().sandbox.id;
    await executor.freeze(doomedId);
    await executor.stop(doomedId);

    const res = await rpc(app, '/listSandboxMetrics', {});
    const { samples } = listSandboxMetricsResponseSchema.parse(res.json());
    expect(samples.map((s) => s.sandboxName)).toEqual(['alive']);
  });

  it('answers an empty list on an empty ledger', async () => {
    const { app } = testApp();
    const res = await rpc(app, '/listSandboxMetrics', {});
    expect(listSandboxMetricsResponseSchema.parse(res.json()).samples).toEqual(
      [],
    );
  });
});

describe('listSandboxImages', () => {
  async function images(app: Parameters<typeof rpc>[0]) {
    const res = await rpc(app, '/listSandboxImages', {});
    expect(res.statusCode).toBe(200);
    return listSandboxImagesResponseSchema.parse(res.json()).images;
  }

  it('walks a template upgrade: in sync, left behind, rebuilt, in sync again', async () => {
    const { app } = testApp();
    await rpc(app, '/registerTemplate', { name: 'py', image: 'img-v1' });
    const created = (
      await rpc(app, '/acquireSandbox', { name: 'alice', template: 'py' })
    ).json().sandbox;

    // Fresh: the shell was born from the template's current image.
    expect(await images(app)).toEqual([
      {
        sandboxName: 'alice',
        sandboxId: created.id,
        image: 'img-v1',
        nextImage: 'img-v1',
        upgradable: false,
      },
    ]);

    // Re-registering moves nextImage; the live shell honestly stays behind.
    await rpc(app, '/registerTemplate', { name: 'py', image: 'img-v2' });
    expect(await images(app)).toMatchObject([
      { image: 'img-v1', nextImage: 'img-v2', upgradable: true },
    ]);

    // Rebuild removes the shell: no image to report, and nothing to upgrade
    // — the next boot resolves the current image by itself.
    await rpc(app, '/rebuildSandbox', { name: 'alice' });
    expect(await images(app)).toMatchObject([
      { image: null, nextImage: 'img-v2', upgradable: false },
    ]);

    // Woken: born from the template's current image, in sync again.
    await rpc(app, '/acquireSandbox', { name: 'alice' });
    expect(await images(app)).toMatchObject([
      { image: 'img-v2', nextImage: 'img-v2', upgradable: false },
    ]);
  });

  it('compares template-less sandboxes against the executor base image', async () => {
    const { app } = testApp();
    await rpc(app, '/acquireSandbox', { name: 'plain' });
    expect(await images(app)).toMatchObject([
      { image: FAKE_BASE_IMAGE, nextImage: FAKE_BASE_IMAGE, upgradable: false },
    ]);
  });

  it('answers every row: a stopped shell keeps its old image, honestly upgradable', async () => {
    const { app, db, executor } = testApp();
    await rpc(app, '/registerTemplate', { name: 'py', image: 'img-v1' });
    const created = (
      await rpc(app, '/acquireSandbox', { name: 'cold', template: 'py' })
    ).json().sandbox;
    await freezeSandbox(db, executor, created.id);
    await stopSandbox(db, executor, created.id);
    await rpc(app, '/registerTemplate', { name: 'py', image: 'img-v2' });

    // The exited container is still the shell: waking it would boot the old
    // image, so the row is honestly reported as upgradable.
    expect(await images(app)).toMatchObject([
      { image: 'img-v1', nextImage: 'img-v2', upgradable: true },
    ]);
    // Observation is not activity: still stopped afterwards.
    const { sandboxes } = (await rpc(app, '/listSandboxes')).json();
    expect(sandboxes[0].state).toBe('stopped');
  });
});
