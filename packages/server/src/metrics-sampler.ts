import type { Db } from './db/db';
import { countByState, listSandboxes } from './db/ledger';
import { insertMetricsTick } from './db/metrics';
import type { Executor, SandboxMetrics } from './executor/executor';

/**
 * The metrics sampler: one tick reads every measurable sandbox and the
 * fleet's state census, and persists both. This is the daemon keeping
 * history — a reversal of the original "observation window, not a
 * monitoring system" stance, overturned for three reasons (2026-07-15):
 * the E2B metrics endpoint's start/end slice is a compatibility contract
 * we were answering with a single sample; per-sandbox readings cannot be
 * scraped from outside the ledger (host trends still belong to
 * Prometheus); and the console was hoarding session-local history in the
 * browser as a workaround. What did NOT reverse: observation never wakes a
 * sandbox — executor.metrics reads running and paused containers alike and
 * starts nothing — and a window the daemon slept through stays honestly
 * empty.
 *
 * Runs on its own chained ticker, not the heartbeat's: a heartbeat tick
 * legitimately runs 45s+ (memory.reclaim), and sampling cadence must not
 * inherit that jitter.
 */

export interface SampleResult {
  /** Measurable sandboxes whose reading landed in the ledger. */
  sampled: number;
  /** Measurable sandboxes skipped — container vanished mid-reading. */
  skipped: number;
}

/**
 * One sampling pass. `now` is injected so tests can travel in time instead
 * of sleeping (the scanner's rule). Readings run in parallel — one
 * docker-stats sample costs about a second, serial would scale the tick
 * with the fleet — and a container that vanishes mid-reading is skipped,
 * never invented. All rows land in a single synchronous transaction after
 * the async reads complete (insertMetricsTick).
 */
export async function sampleOnce(
  db: Db,
  executor: Executor,
  now: Date,
  opts: { retentionHours: number },
): Promise<SampleResult> {
  const rows = listSandboxes(db);
  const { byState, total } = countByState(rows);
  const measurable = rows.filter(
    (row) => row.state === 'active' || row.state === 'frozen',
  );
  const readings = await Promise.all(
    measurable.map(
      async (
        row,
      ): Promise<{ sandboxId: string; metrics: SandboxMetrics } | null> => {
        try {
          return {
            sandboxId: row.sandboxId,
            metrics: await executor.metrics(row.sandboxId),
          };
        } catch {
          return null;
        }
      },
    ),
  );
  const samples = readings.filter((reading) => reading !== null);
  insertMetricsTick(db, {
    at: now.toISOString(),
    fleetCounts: { ...byState, total },
    samples,
    retentionHours: opts.retentionHours,
  });
  return {
    sampled: samples.length,
    skipped: measurable.length - samples.length,
  };
}
