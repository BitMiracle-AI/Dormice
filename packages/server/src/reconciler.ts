import type { SandboxState } from '@dormice/shared';
import type { Db } from './db/db';
import { deleteSandbox, listSandboxes, overwriteState } from './db/ledger';
import type { ContainerState, Executor } from './executor/executor';

export interface ReconcileResult {
  /** Rows whose state was corrected to what the container actually is. */
  repairedStates: number;
  /** Rows deleted because their container no longer exists. */
  deletedRows: number;
  /** Containers destroyed because no row points at them. */
  destroyedOrphans: number;
}

/** What a container's observed state means in ledger terms. */
const LEDGER_STATE: Record<ContainerState, SandboxState> = {
  running: 'active',
  paused: 'frozen',
  stopped: 'stopped',
};

/**
 * Runs once at startup, before the daemon serves traffic: reads all of
 * reality in one call and repairs every disagreement with the ledger.
 * Lifecycle operations write reality first and the ledger second, so a
 * crash in between leaves exactly the drift handled here.
 *
 * Reality wins every case:
 * - state differs   -> the row is overwritten with the observed state
 * - container gone  -> the row is deleted; the user key is free again, and
 *                      the next acquire honestly builds a fresh sandbox
 *                      (gVisor kills a whole box on OOM — "the container
 *                      can vanish at any time" is expected, not special)
 * - row gone        -> the container is destroyed; without a row it has no
 *                      user key, so nothing could ever reach it again
 *
 * Archived and restoring rows are skipped: those sandboxes live in S3, not
 * in the executor, and their reconciliation lands with the archiver.
 */
export async function reconcile(
  db: Db,
  executor: Executor,
): Promise<ReconcileResult> {
  const containers = await executor.listContainers();
  const result: ReconcileResult = {
    repairedStates: 0,
    deletedRows: 0,
    destroyedOrphans: 0,
  };

  for (const row of listSandboxes(db)) {
    const observed = containers.get(row.sandboxId);
    containers.delete(row.sandboxId);
    if (row.state === 'archived' || row.state === 'restoring') {
      continue;
    }
    if (observed === undefined) {
      deleteSandbox(db, row.sandboxId);
      result.deletedRows += 1;
    } else if (LEDGER_STATE[observed] !== row.state) {
      overwriteState(db, row.sandboxId, LEDGER_STATE[observed]);
      result.repairedStates += 1;
    }
  }

  // Everything still in the map has no ledger row.
  for (const sandboxId of containers.keys()) {
    await executor.destroy(sandboxId);
    result.destroyedOrphans += 1;
  }

  return result;
}
