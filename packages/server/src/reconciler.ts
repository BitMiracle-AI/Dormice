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
  /** Disks removed because neither a row nor a container owns them. */
  removedDisks: number;
  /**
   * Containers and disks with no row, seen for the first time — not
   * destroyed yet. The caller passes them back as `priorSuspects` on the
   * next run.
   */
  suspects: string[];
}

/** What a container's observed state means in ledger terms. */
const LEDGER_STATE: Record<ContainerState, SandboxState> = {
  running: 'active',
  paused: 'frozen',
  stopped: 'stopped',
};

/**
 * Reads all of reality in one call and repairs every disagreement with the
 * ledger. Runs once at startup, before the daemon serves traffic, and then
 * on every scanner tick: containers vanish while the daemon runs (gVisor
 * kills a whole box on OOM), and drift that is only repaired at boot would
 * leave acquire returning corpses and stall the idle scanner until the next
 * restart.
 *
 * Reality is container plus disk, and reality wins every case:
 * - state differs   -> the row is overwritten with the observed state
 * - container gone  -> the row is deleted; the user key is free again, and
 *                      the next acquire honestly builds a fresh sandbox
 * - row gone        -> the container is destroyed; without a row it has no
 *                      user key, so nothing could ever reach it again
 * - disk owned by nothing -> removed; leaked disks would silently eat the
 *                      host (a crash between create's steps, a destroy that
 *                      removed the container but failed the disk teardown)
 *
 * Orphan destruction takes two strikes at runtime: a container or disk
 * whose acquire is still in flight has no row yet, and killing it would
 * sabotage the very request creating it. Whatever is still unowned on two
 * consecutive passes (a scan interval apart) is genuinely unreachable.
 * `priorSuspects` carries the first strikes between runs; omitting it (at
 * startup, when nothing can be in flight) destroys orphans immediately.
 *
 * Archived and restoring rows are skipped: those sandboxes live in S3, not
 * in the executor, and their reconciliation lands with the archiver.
 */
export async function reconcile(
  db: Db,
  executor: Executor,
  priorSuspects?: ReadonlySet<string>,
): Promise<ReconcileResult> {
  const containers = await executor.listContainers();
  const disks = await executor.listDisks();
  const result: ReconcileResult = {
    repairedStates: 0,
    deletedRows: 0,
    destroyedOrphans: 0,
    removedDisks: 0,
    suspects: [],
  };
  // Everything a disk may legitimately belong to: rows that survive this
  // pass, and containers that still exist afterwards (destroy tears its
  // own disk, so a container's disk is never removed out from under it).
  const owners = new Set<string>();

  for (const row of listSandboxes(db)) {
    const observed = containers.get(row.sandboxId);
    containers.delete(row.sandboxId);
    if (row.state === 'archived' || row.state === 'restoring') {
      owners.add(row.sandboxId);
      continue;
    }
    if (observed === undefined) {
      deleteSandbox(db, row.sandboxId);
      result.deletedRows += 1;
    } else {
      owners.add(row.sandboxId);
      if (LEDGER_STATE[observed] !== row.state) {
        overwriteState(db, row.sandboxId, LEDGER_STATE[observed]);
        result.repairedStates += 1;
      }
    }
  }

  // Everything still in the map has no ledger row. Either way the disk is
  // accounted for — destroy tears its own, a suspect keeps its — so the
  // disk pass below must not touch these ids.
  for (const sandboxId of containers.keys()) {
    if (priorSuspects === undefined || priorSuspects.has(sandboxId)) {
      await executor.destroy(sandboxId);
      result.destroyedOrphans += 1;
    } else {
      result.suspects.push(sandboxId);
    }
    owners.add(sandboxId);
  }

  for (const sandboxId of disks) {
    if (owners.has(sandboxId)) continue;
    if (priorSuspects === undefined || priorSuspects.has(sandboxId)) {
      await executor.removeDisk(sandboxId);
      result.removedDisks += 1;
    } else {
      result.suspects.push(sandboxId);
    }
  }

  return result;
}
