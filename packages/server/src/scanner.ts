import type { Db } from './db/db';
import { listSandboxes } from './db/ledger';
import type { Executor } from './executor/executor';
import { freezeSandbox, stopSandbox } from './lifecycle';

export interface ScanResult {
  frozen: number;
  stopped: number;
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
 * An executor failure aborts the sweep loudly (the caller logs it). The
 * ledger is only written after reality moved, so the aborted sandbox was
 * not recorded as changed — the next sweep simply retries it.
 */
export async function scanOnce(
  db: Db,
  executor: Executor,
  now: Date,
): Promise<ScanResult> {
  const result: ScanResult = { frozen: 0, stopped: 0 };
  for (const row of listSandboxes(db)) {
    const idleSeconds = (now.getTime() - Date.parse(row.lastActiveAt)) / 1000;
    if (row.state === 'active' && idleSeconds >= row.freezeAfterSeconds) {
      await freezeSandbox(db, executor, row.sandboxId);
      result.frozen += 1;
    } else if (row.state === 'frozen' && idleSeconds >= row.stopAfterSeconds) {
      await stopSandbox(db, executor, row.sandboxId);
      result.stopped += 1;
    }
    // stopped -> archived lands with the S3 archiver. The archiveAfterSeconds
    // knob already exists so sandboxes created today carry their intent.
  }
  return result;
}
