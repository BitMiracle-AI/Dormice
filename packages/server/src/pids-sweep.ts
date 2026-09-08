import type { Db } from './db/db';
import { findById, listSandboxes } from './db/ledger';
import type { Executor } from './executor/executor';
import type { KeyedQueue } from './keyed-queue';

export interface PidsSweep {
  /** Active rows the sweep looked at. */
  considered: number;
  /** Shells brought to the configured cap in place. */
  updated: number;
  /**
   * Rows with no running shell to update once their slot was ours: a shell
   * that died under its row (the reconciler's case), or a row that left
   * active while the sweep waited for its slot.
   */
  skipped: number;
  /** One line per shell the runtime refused or timed out on: `name: message`. */
  failures: string[];
}

/**
 * Brings every running shell's pids cap to the value in force, in place.
 *
 * The cap is read live at every birth and applied at every wake (the
 * executor's own convergence), so a shell can only be stale while it keeps
 * running across a change of the value — and the value changes at exactly
 * two moments: an updateSettings write, and a daemon boot that seeds or
 * adopts a different number than the fleet was born under (the upgrade
 * that moved the default from 512 to 4096, for one). Sweeping at those two
 * moments covers every running shell without a periodic patrol: inspecting
 * the whole fleet every tick for a knob that moves once a year is a cost
 * with nothing to buy. The sandboxes that matter here are precisely the
 * running ones — a sandbox busy enough to reach the cap is not idle enough
 * to have frozen — so waiting for their next wake would have cost each of
 * them one more death. Measured 2026-09-08 (test machine, 30 running
 * shells): ~27 ms per shell updated, under 1 ms per shell already in force.
 *
 * Only active rows are considered: a frozen shell cannot be updated (the
 * runtime refuses while paused) and a stopped one takes the cap at its
 * start, both the wake's business. Each row is visited inside its own
 * queue slot — waited for, never skipped. The reconciler and scanner skip
 * a busy key because their observation came from a snapshot the holder may
 * have invalidated; this sweep observes nothing until it holds the slot
 * (the row is re-read and the shell inspected inside it), so waiting is
 * always correct, and skipping would leave exactly one running shell at
 * the old cap with no next moment to catch it — a busy sandbox may not
 * wake for hours, and an acquire's touch or an exec's wake holds the slot
 * of exactly such a sandbox for a few milliseconds at a time. The wait is
 * bounded by whatever the holder is doing (a touch, a wake, at worst a
 * freeze's memory.reclaim); no slot held by a restore is ever waited on,
 * since restoring rows are not active. A refused or timed-out update is
 * recorded by name, never thrown: the ledger already holds the new value,
 * every other shell still gets its turn, and the caller decides how loudly
 * to report the remainder.
 */
export async function sweepPidsLimit(
  db: Db,
  executor: Executor,
  locks: KeyedQueue,
  /** Called once per row considered — the heartbeat watchdog's evidence of progress. */
  onProgress?: () => void,
): Promise<PidsSweep> {
  const result: PidsSweep = {
    considered: 0,
    updated: 0,
    skipped: 0,
    failures: [],
  };
  for (const row of listSandboxes(db)) {
    if (row.state !== 'active') continue;
    result.considered += 1;
    onProgress?.();
    try {
      const outcome = await locks.run(row.name, async () => {
        const fresh = findById(db, row.id);
        if (fresh === undefined || fresh.state !== 'active') {
          return 'skipped' as const;
        }
        return executor.convergePidsLimit(row.id);
      });
      if (outcome === 'updated') result.updated += 1;
      else if (outcome === 'skipped') result.skipped += 1;
      // 'in-force' is the common case and not worth a counter.
    } catch (error) {
      result.failures.push(
        `${row.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}
