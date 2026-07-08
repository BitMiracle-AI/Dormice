import type { Db } from './db/db';
import { listSandboxes } from './db/ledger';
import type { Executor } from './executor/executor';
import { freezeSandbox, stopSandbox } from './lifecycle';

export interface ScanResult {
  frozen: number;
  stopped: number;
  /** Sandboxes whose transition failed this sweep; the caller logs them. */
  failures: Array<{ sandboxId: string; message: string }>;
}

/**
 * One sweep of the idle scanner: measures every sandbox's idle time from
 * lastActiveAt against its own policy and moves it one rung colder when a
 * threshold has passed. One rung per sweep, mirroring ALLOWED_TRANSITIONS —
 * a long-dead sandbox freezes on this sweep and stops on the next; nothing
 * ever skips a state.
 *
 * `now` is injected so tests can travel in time instead of sleeping.
 *
 * One sandbox's failure must not punish the rest: a vanished container (a
 * gVisor OOM kills the whole box) would otherwise block every row behind it
 * on every sweep, and cooling — the product's core promise — would silently
 * stall. Failures are collected per row and reported in the result; the
 * ledger is only written after reality moved, so a failed row was not
 * recorded as changed and stays visible to reconciliation.
 */
export async function scanOnce(
  db: Db,
  executor: Executor,
  now: Date,
): Promise<ScanResult> {
  const result: ScanResult = { frozen: 0, stopped: 0, failures: [] };
  for (const row of listSandboxes(db)) {
    const idleSeconds = (now.getTime() - Date.parse(row.lastActiveAt)) / 1000;
    try {
      if (row.state === 'active' && idleSeconds >= row.freezeAfterSeconds) {
        await freezeSandbox(db, executor, row.sandboxId);
        result.frozen += 1;
      } else if (
        row.state === 'frozen' &&
        idleSeconds >= row.stopAfterSeconds
      ) {
        await stopSandbox(db, executor, row.sandboxId);
        result.stopped += 1;
      }
      // stopped -> archived lands with the S3 archiver. The archiveAfterSeconds
      // knob already exists so sandboxes created today carry their intent.
    } catch (error) {
      result.failures.push({
        sandboxId: row.sandboxId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
