import { and, asc, desc, eq, gte, inArray, lt, lte } from 'drizzle-orm';
import type { SandboxMetrics } from '../executor/executor';
import type { Db } from './db';
import {
  type FleetSnapshotRow,
  fleetSnapshots,
  type SandboxMetricsSampleRow,
  sandboxes,
  sandboxMetricsSamples,
} from './schema';

/**
 * How long fleet snapshots live. Not a knob: the dashboard's widest range
 * (30 days) defines the need, and at one small row per tick the table stays
 * a few megabytes — nobody sizes an explanation window (ACTIVITY_KEEP's
 * reasoning). Per-sandbox samples DO get a knob
 * (DORMICE_METRICS_RETENTION_HOURS): their volume scales with fleet size.
 */
export const FLEET_SNAPSHOT_KEEP_DAYS = 30;

/**
 * The most points a history answer carries. One ceiling for every consumer
 * (native verbs and the E2B slice alike): past it the server buckets, so a
 * 30-day window costs ~360 points on the wire instead of 86k raw rows no
 * chart could draw anyway.
 */
export const MAX_POINTS = 360;

export interface FleetCounts {
  active: number;
  frozen: number;
  stopped: number;
  archived: number;
  restoring: number;
  total: number;
}

export interface MetricsTickInput {
  /** ISO 8601 UTC — the tick's single timestamp, shared by every row. */
  at: string;
  fleetCounts: FleetCounts;
  samples: Array<{ sandboxId: string; metrics: SandboxMetrics }>;
  retentionHours: number;
}

/**
 * Writes one sampler tick — fleet snapshot, per-sandbox samples, and both
 * retention prunes — in a single synchronous transaction: a tick's data is
 * either fully visible or not at all. Sampling (async, ~1s per container)
 * happened before this call; better-sqlite3 transactions cannot span an
 * await, so "collect first, write once" is not a choice but a law.
 *
 * Samples are re-filtered against the ledger inside the transaction: a
 * sandbox destroyed while its reading was in flight must not leave orphan
 * history rows behind.
 */
export function insertMetricsTick(db: Db, input: MetricsTickInput): void {
  const sampleCutoff = new Date(
    Date.parse(input.at) - input.retentionHours * 3600_000,
  ).toISOString();
  const fleetCutoff = new Date(
    Date.parse(input.at) - FLEET_SNAPSHOT_KEEP_DAYS * 86_400_000,
  ).toISOString();

  db.transaction((tx) => {
    tx.insert(fleetSnapshots)
      .values({ at: input.at, ...input.fleetCounts })
      .run();

    if (input.samples.length > 0) {
      const liveIds = new Set(
        tx
          .select({ sandboxId: sandboxes.sandboxId })
          .from(sandboxes)
          .where(
            inArray(
              sandboxes.sandboxId,
              input.samples.map((s) => s.sandboxId),
            ),
          )
          .all()
          .map((r) => r.sandboxId),
      );
      const rows = input.samples
        .filter((s) => liveIds.has(s.sandboxId))
        .map((s) => ({ sandboxId: s.sandboxId, at: input.at, ...s.metrics }));
      if (rows.length > 0) {
        tx.insert(sandboxMetricsSamples).values(rows).run();
      }
    }

    tx.delete(sandboxMetricsSamples)
      .where(lt(sandboxMetricsSamples.at, sampleCutoff))
      .run();
    tx.delete(fleetSnapshots).where(lt(fleetSnapshots.at, fleetCutoff)).run();
  });
}

/**
 * The destroy cascade: a sandbox whose disk is gone has no owner for its
 * history. Fleet snapshots are untouched — they belong to no sandbox.
 */
export function deleteSandboxMetricsSamples(db: Db, sandboxId: string): void {
  db.delete(sandboxMetricsSamples)
    .where(eq(sandboxMetricsSamples.sandboxId, sandboxId))
    .run();
}

/** Ascending slice — ISO strings compare lexicographically as time. */
export function querySandboxSamples(
  db: Db,
  sandboxId: string,
  startIso: string,
  endIso: string,
): SandboxMetricsSampleRow[] {
  return db
    .select()
    .from(sandboxMetricsSamples)
    .where(
      and(
        eq(sandboxMetricsSamples.sandboxId, sandboxId),
        gte(sandboxMetricsSamples.at, startIso),
        lte(sandboxMetricsSamples.at, endIso),
      ),
    )
    .orderBy(asc(sandboxMetricsSamples.at))
    .all();
}

/** Ascending slice of fleet snapshots. */
export function queryFleetSnapshots(
  db: Db,
  startIso: string,
  endIso: string,
): FleetSnapshotRow[] {
  return db
    .select()
    .from(fleetSnapshots)
    .where(
      and(gte(fleetSnapshots.at, startIso), lte(fleetSnapshots.at, endIso)),
    )
    .orderBy(asc(fleetSnapshots.at))
    .all();
}

/**
 * The window's concurrency peak, from raw rows so no bucketing can flatten
 * it: highest active count, and the earliest instant it was observed.
 */
export function queryFleetPeak(
  db: Db,
  startIso: string,
  endIso: string,
): { active: number; at: string } | null {
  const row = db
    .select({ active: fleetSnapshots.active, at: fleetSnapshots.at })
    .from(fleetSnapshots)
    .where(
      and(gte(fleetSnapshots.at, startIso), lte(fleetSnapshots.at, endIso)),
    )
    .orderBy(desc(fleetSnapshots.active), asc(fleetSnapshots.at))
    .limit(1)
    .get();
  return row ?? null;
}

/**
 * Resolves a history verb's optional ISO window: end defaults to now, start
 * to end minus the verb's default span. One resolver for both verbs so
 * "defaults" cannot drift apart. Parseability is the request schema's job
 * (a malformed timestamp is rejected as a 400 at the door, never NaN here).
 */
export function resolveWindow(
  start: string | undefined,
  end: string | undefined,
  defaultSpanMs: number,
  now: Date,
): { startIso: string; endIso: string; startMs: number; endMs: number } {
  const endMs = end !== undefined ? Date.parse(end) : now.getTime();
  const startMs =
    start !== undefined ? Date.parse(start) : endMs - defaultSpanMs;
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    startMs,
    endMs,
  };
}

/**
 * Decides the answer's granularity: raw under MAX_POINTS, bucketed past it.
 * The server picks — one ruling for every caller, clients never negotiate.
 */
export function resolveBucketSeconds(
  rawCount: number,
  startMs: number,
  endMs: number,
): number | null {
  if (rawCount <= MAX_POINTS) return null;
  return Math.max(1, Math.ceil((endMs - startMs) / 1000 / MAX_POINTS));
}

function bucketIndex(atIso: string, startMs: number, bucketSeconds: number) {
  return Math.floor((Date.parse(atIso) - startMs) / (bucketSeconds * 1000));
}

/**
 * Buckets per-sandbox samples by per-field max: someone reading history is
 * hunting for spikes, and averaging erases exactly what they came for. Each
 * metric is charted alone (never sharing an axis), so an independent
 * per-field envelope is honest within every chart. The bucket's timestamp
 * is its start — a synthetic instant, which callers' copy must say.
 */
export function bucketSamples(
  rows: SandboxMetricsSampleRow[],
  startMs: number,
  bucketSeconds: number,
): SandboxMetricsSampleRow[] {
  const buckets = new Map<number, SandboxMetricsSampleRow>();
  for (const row of rows) {
    const idx = bucketIndex(row.at, startMs, bucketSeconds);
    const seen = buckets.get(idx);
    if (!seen) {
      buckets.set(idx, {
        ...row,
        at: new Date(startMs + idx * bucketSeconds * 1000).toISOString(),
      });
      continue;
    }
    seen.cpuCount = Math.max(seen.cpuCount, row.cpuCount);
    seen.cpuUsedPct = Math.max(seen.cpuUsedPct, row.cpuUsedPct);
    seen.memUsedBytes = Math.max(seen.memUsedBytes, row.memUsedBytes);
    seen.memTotalBytes = Math.max(seen.memTotalBytes, row.memTotalBytes);
    seen.memCacheBytes = Math.max(seen.memCacheBytes, row.memCacheBytes);
    seen.diskUsedBytes = Math.max(seen.diskUsedBytes, row.diskUsedBytes);
    seen.diskTotalBytes = Math.max(seen.diskTotalBytes, row.diskTotalBytes);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}

/**
 * Buckets fleet snapshots by keeping each bucket's LAST raw row whole —
 * never per-state maxima, which would count a sandbox mid-transition twice
 * and break byState summing to total. Every emitted point is a snapshot
 * that really happened; the peak travels separately (queryFleetPeak).
 */
export function bucketSnapshots(
  rows: FleetSnapshotRow[],
  startMs: number,
  bucketSeconds: number,
): FleetSnapshotRow[] {
  const buckets = new Map<number, FleetSnapshotRow>();
  for (const row of rows) {
    // Rows arrive ascending, so a later row simply overwrites the bucket.
    buckets.set(bucketIndex(row.at, startMs, bucketSeconds), row);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}
