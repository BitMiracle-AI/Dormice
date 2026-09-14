import { fileURLToPath } from 'node:url';
import {
  getHostMetricsHistoryResponseSchema,
  getSandboxMetricsHistoryResponseSchema,
  getSandboxMetricsResponseSchema,
  listSandboxImagesResponseSchema,
  listSandboxMetricsResponseSchema,
} from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { migrateDb, openDb } from '../db/db';
import { insertMetricsTick } from '../db/metrics';
import { FAKE_BASE_IMAGE, FakeExecutor } from '../executor/fake';
import { MAX_POINTS } from '../history';
import { CpuSampler, type HostSample } from '../host-metrics';
import { KeyedQueue } from '../keyed-queue';
import { freezeSandbox, stopSandbox } from '../lifecycle';
import { sampleOnce } from '../metrics-sampler';
import { configureNode, registerTestTemplate } from '../testing';

// The observability verbs, app-level: getSandboxMetrics, the history
// windows and the image lineage — the console's food, so the tests eat
// exactly what a browser would.

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const TOKEN = 'test-token-test-token-test-token';
const authed = { authorization: `Bearer ${TOKEN}` };

function testApp() {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const config = loadConfig({
    DORMICE_DB_PATH: ':memory:',
    DORMICE_NODE_ID: 'node-test',
    DORMICE_API_TOKEN: TOKEN,
  });
  configureNode(db);
  const executor = new FakeExecutor();
  const locks = new KeyedQueue();
  const app = buildApp({ config, db, executor, locks, logger: false });
  return { app, db, executor, locks };
}

type App = ReturnType<typeof testApp>['app'];

function rpc(app: App, url: string, payload: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url, headers: authed, payload });
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
      swapUsedBytes: 0,
      swapTotalBytes: 2048,
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
    insertMetricsTick(db, {
      at: new Date(t0).toISOString(),
      host: hostReading(null),
      samples: [],
      retentionHours: 168,
    });
    insertMetricsTick(db, {
      at: new Date(t0 + 30_000).toISOString(),
      host: hostReading(40),
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
    const { app, db } = testApp();
    registerTestTemplate(db, 'py', 'img-v1');
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

    // Re-pointing the template (the gateway's registerTemplate, arriving
    // with the next bundle) moves nextImage; the live shell stays behind.
    registerTestTemplate(db, 'py', 'img-v2');
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
    registerTestTemplate(db, 'py', 'img-v1');
    const created = (
      await rpc(app, '/acquireSandbox', { name: 'cold', template: 'py' })
    ).json().sandbox;
    await freezeSandbox(db, executor, created.id);
    await stopSandbox(db, executor, created.id);
    registerTestTemplate(db, 'py', 'img-v2');

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
