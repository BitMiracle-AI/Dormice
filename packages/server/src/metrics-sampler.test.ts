import { fileURLToPath } from 'node:url';
import { count } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { CONFIG_KEYS, type ConfigSources, loadConfig } from './config';
import { migrateDb, openDb } from './db/db';
import { FLEET_SNAPSHOT_KEEP_DAYS, insertMetricsTick } from './db/metrics';
import {
  fleetSnapshots,
  hostMetricsSamples,
  sandboxMetricsSamples,
} from './db/schema';
import { FakeExecutor } from './executor/fake';
import { CpuSampler, type HostSample } from './host-metrics';
import { KeyedQueue } from './keyed-queue';
import { freezeSandbox, stopSandbox } from './lifecycle';
import { sampleOnce } from './metrics-sampler';

// The sampler, unit-level: one tick's writes, the measurable-states gate,
// the vanished-container skip, retention pruning and the destroy cascade.
// Time is injected (`now`), never slept on — the scanner's rule.

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const TOKEN = 'test-token-test-token-test-token';
const authed = { authorization: `Bearer ${TOKEN}` };

// One tick's non-sandbox inputs. A fresh CpuSampler per call is fine: its
// delta-less first reading is an honest null — exactly what the tick after
// a daemon start writes. The data dir doesn't exist, so disk is null too.
function tickOpts() {
  return {
    retentionHours: 168,
    hostCpu: new CpuSampler(),
    dataDir: '/nowhere/dormice-metrics-test',
  };
}

// A fixed host reading for straight-to-the-writer tests.
const HOST: HostSample = {
  cpuUsedPct: 12,
  memTotalBytes: 4096,
  memAvailableBytes: 2048,
  swapTotalBytes: null,
  swapUsedBytes: null,
  diskTotalBytes: null,
  diskUsedBytes: null,
  diskAvailableBytes: null,
};

function fixedSources(): ConfigSources {
  const all = Object.fromEntries(
    Object.keys(CONFIG_KEYS).map((key) => [key, 'default']),
  ) as ConfigSources;
  return { ...all, DORMICE_API_TOKEN: 'env' };
}

function harness() {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const config = loadConfig({
    DORMICE_DB_PATH: ':memory:',
    DORMICE_API_TOKEN: TOKEN,
  });
  const executor = new FakeExecutor();
  const locks = new KeyedQueue();
  const app = buildApp({
    config,
    db,
    executor,
    locks,
    logger: false,
    sources: fixedSources(),
  });
  return { app, db, executor, locks };
}

type App = ReturnType<typeof harness>['app'];

async function acquire(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/acquireSandbox',
    headers: authed,
    payload: { name },
  });
  expect(res.statusCode).toBe(200);
  return res.json().sandbox as { id: string };
}

function sampleRows(db: ReturnType<typeof harness>['db']) {
  return db.select().from(sandboxMetricsSamples).all();
}

function fleetRows(db: ReturnType<typeof harness>['db']) {
  return db.select().from(fleetSnapshots).all();
}

function hostRows(db: ReturnType<typeof harness>['db']) {
  return db.select().from(hostMetricsSamples).all();
}

describe('sampleOnce', () => {
  it('writes one fleet row and one sample per measurable sandbox', async () => {
    const { app, db, executor } = harness();
    await acquire(app, 'hot');
    const napping = await acquire(app, 'napping');
    await freezeSandbox(db, executor, napping.id);
    const cold = await acquire(app, 'cold');
    await freezeSandbox(db, executor, cold.id);
    await stopSandbox(db, executor, cold.id);

    const now = new Date('2026-07-15T10:00:00.000Z');
    const result = await sampleOnce(db, executor, now, tickOpts());

    // Active and frozen are measured; stopped has no container and is not.
    expect(result).toEqual({ sampled: 2, skipped: 0 });
    const fleet = fleetRows(db);
    expect(fleet).toEqual([
      {
        at: now.toISOString(),
        active: 1,
        frozen: 1,
        stopped: 1,
        archived: 0,
        restoring: 0,
        total: 3,
      },
    ]);
    const samples = sampleRows(db);
    expect(samples).toHaveLength(2);
    for (const row of samples) {
      expect(row.at).toBe(now.toISOString());
      expect(row.memTotalBytes).toBeGreaterThan(0);
    }
    // The machine's own reading lands on the same tick: real memory, and
    // honest nulls for what this run cannot read (a data dir that doesn't
    // exist, a CPU delta the fresh sampler doesn't have yet).
    const host = hostRows(db);
    expect(host).toHaveLength(1);
    expect(host[0]?.at).toBe(now.toISOString());
    expect(host[0]?.memTotalBytes).toBeGreaterThan(0);
    expect(host[0]?.memAvailableBytes).toBeGreaterThan(0);
    expect(host[0]?.diskTotalBytes).toBe(null);
    // Observation is not activity: the frozen sandbox is still frozen.
    expect((await executor.listContainers()).get(napping.id)).toBe('paused');
  });

  it('skips a vanished container without failing the tick', async () => {
    const { app, db, executor } = harness();
    await acquire(app, 'alive');
    const doomed = await acquire(app, 'doomed');
    // The container dies physically, past the ledger (gVisor OOM does this
    // for real) — the row still says active, the reading throws.
    await executor.freeze(doomed.id);
    await executor.stop(doomed.id);

    const now = new Date('2026-07-15T10:00:00.000Z');
    const result = await sampleOnce(db, executor, now, tickOpts());
    expect(result).toEqual({ sampled: 1, skipped: 1 });
    expect(sampleRows(db)).toHaveLength(1);
    // The fleet row still lands: state counts come from the ledger, not
    // from what happened to be measurable.
    expect(fleetRows(db)).toHaveLength(1);
  });

  it('prunes samples past retention and fleet rows past 30 days', async () => {
    const { app, db, executor } = harness();
    await acquire(app, 'steady');

    const early = new Date('2026-07-01T00:00:00.000Z');
    await sampleOnce(db, executor, early, tickOpts());

    // One retention window plus a minute later: the early sample must fall,
    // the early fleet row (well within 30 days) must survive.
    const later = new Date(early.getTime() + 168 * 3600_000 + 60_000);
    await sampleOnce(db, executor, later, tickOpts());
    expect(sampleRows(db).map((r) => r.at)).toEqual([later.toISOString()]);
    expect(fleetRows(db).map((r) => r.at)).toEqual([
      early.toISOString(),
      later.toISOString(),
    ]);

    // Past the fleet's own 30-day window the early fleet row falls too,
    // and the host samples share that window exactly.
    const ancientCutoff = new Date(
      early.getTime() + (FLEET_SNAPSHOT_KEEP_DAYS * 24 + 1) * 3600_000,
    );
    await sampleOnce(db, executor, ancientCutoff, tickOpts());
    expect(fleetRows(db).map((r) => r.at)).toEqual([
      later.toISOString(),
      ancientCutoff.toISOString(),
    ]);
    expect(hostRows(db).map((r) => r.at)).toEqual([
      later.toISOString(),
      ancientCutoff.toISOString(),
    ]);
  });

  it("destroy cascades to the sandbox's samples and nobody else's", async () => {
    const { app, db, executor } = harness();
    const victim = await acquire(app, 'victim');
    await acquire(app, 'bystander');
    await sampleOnce(
      db,
      executor,
      new Date('2026-07-15T10:00:00.000Z'),
      tickOpts(),
    );
    expect(sampleRows(db)).toHaveLength(2);

    const res = await app.inject({
      method: 'POST',
      url: '/destroySandbox',
      headers: authed,
      payload: { name: 'victim' },
    });
    expect(res.statusCode).toBe(200);

    const remaining = sampleRows(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.sandboxId).not.toBe(victim.id);
    // Fleet snapshots belong to no sandbox: untouched.
    expect(fleetRows(db)).toHaveLength(1);
  });

  it('drops a sample whose sandbox was destroyed mid-read (no orphan rows)', () => {
    const { db } = harness();
    // Straight to the writer: a reading collected for a sandbox that no
    // longer has a ledger row must be filtered inside the transaction.
    insertMetricsTick(db, {
      at: '2026-07-15T10:00:00.000Z',
      host: HOST,
      fleetCounts: {
        active: 0,
        frozen: 0,
        stopped: 0,
        archived: 0,
        restoring: 0,
        total: 0,
      },
      samples: [
        {
          sandboxId: 'ghost',
          metrics: {
            cpuCount: 1,
            cpuUsedPct: 0,
            memUsedBytes: 1,
            memTotalBytes: 2,
            memCacheBytes: 0,
            diskUsedBytes: 1,
            diskTotalBytes: 2,
          },
        },
      ],
      retentionHours: 168,
    });
    const total = db
      .select({ n: count() })
      .from(sandboxMetricsSamples)
      .get() as { n: number };
    expect(total.n).toBe(0);
    expect(fleetRows(db)).toHaveLength(1);
  });
});
