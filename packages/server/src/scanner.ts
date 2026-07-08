import type { Db } from './db/db';
import { findBySandboxId, listSandboxes } from './db/ledger';
import type { SandboxRow } from './db/schema';
import type { Executor } from './executor/executor';
import type { KeyedQueue } from './keyed-queue';
import { freezeSandbox, stopSandbox } from './lifecycle';

export interface ScanResult {
  frozen: number;
  stopped: number;
  /** Sandboxes whose transition failed this sweep; the caller logs them. */
  failures: Array<{ sandboxId: string; message: string }>;
}

/**
 * Which one-rung-colder move a row is due for, if any. One rung per sweep,
 * mirroring ALLOWED_TRANSITIONS — a long-dead sandbox freezes on this sweep
 * and stops on the next; nothing ever skips a state.
 */
function dueTransition(row: SandboxRow, now: Date): 'freeze' | 'stop' | null {
  const idleSeconds = (now.getTime() - Date.parse(row.lastActiveAt)) / 1000;
  if (row.state === 'active' && idleSeconds >= row.freezeAfterSeconds) {
    return 'freeze';
  }
  if (
    row.state === 'frozen' &&
    row.stopAfterSeconds !== null &&
    idleSeconds >= row.stopAfterSeconds
  ) {
    // The null check is load-bearing: in JS, `idle >= null` reads null as 0
    // and would stop every never-stop sandbox on its first frozen sweep.
    return 'stop';
  }
  // stopped -> archived lands with the S3 archiver. The archiveAfterSeconds
  // knob already exists so sandboxes created today carry their intent.
  return null;
}

/**
 * One sweep of the idle scanner: measures every sandbox's idle time from
 * lastActiveAt against its own policy and moves it one rung colder when a
 * threshold has passed.
 *
 * `now` is injected so tests can travel in time instead of sleeping.
 *
 * Every move happens inside the sandbox's per-key queue slot, after
 * re-reading the row there: a freeze holds the executor for up to 45s of
 * memory.reclaim, and without the slot an acquire on the same key would
 * slip into that gap, answer "ready", and leave the caller holding a paused
 * sandbox. A key that is already busy is skipped — whatever is running
 * there has fresher knowledge than this sweep's snapshot — and the re-read
 * catches rows that were released or woken between the snapshot and the
 * slot.
 *
 * One sandbox's failure must not punish the rest: a vanished container (a
 * gVisor box exits whole on OOM) would otherwise block every row behind it
 * on every sweep, and cooling — the product's core promise — would silently
 * stall. Failures are collected per row and reported in the result; the
 * ledger is only written after reality moved, so a failed row was not
 * recorded as changed and stays visible to reconciliation.
 */
export async function scanOnce(
  db: Db,
  executor: Executor,
  locks: KeyedQueue,
  now: Date,
): Promise<ScanResult> {
  const result: ScanResult = { frozen: 0, stopped: 0, failures: [] };
  for (const row of listSandboxes(db)) {
    if (dueTransition(row, now) === null) {
      continue;
    }
    try {
      await locks.tryRun(row.userKey, async () => {
        const fresh = findBySandboxId(db, row.sandboxId);
        if (!fresh) {
          return; // Released since the sweep's snapshot.
        }
        const due = dueTransition(fresh, now);
        if (due === 'freeze') {
          await freezeSandbox(db, executor, fresh.sandboxId);
          result.frozen += 1;
        } else if (due === 'stop') {
          await stopSandbox(db, executor, fresh.sandboxId);
          result.stopped += 1;
        }
      });
    } catch (error) {
      result.failures.push({
        sandboxId: row.sandboxId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
