import type { SandboxState } from '@dormice/shared';
import type { Db } from './db/db';
import {
  deleteSandbox,
  findBySandboxId,
  listSandboxes,
  overwriteState,
} from './db/ledger';
import type { SandboxRow } from './db/schema';
import type { ContainerState, Executor } from './executor/executor';
import type { KeyedQueue } from './keyed-queue';

export interface ReconcileResult {
  /** Rows whose state was corrected to what reality actually shows. */
  repairedStates: number;
  /** Rows deleted because both the container and the disk are gone. */
  deletedRows: number;
  /** Containers destroyed because no row points at them. */
  destroyedOrphans: number;
  /** Disks removed because neither a row nor a container owns them. */
  removedDisks: number;
  /** Stale local remains of archived rows swept away (interrupted cleanups). */
  archivedSwept: number;
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
 * Reads the ledger, then all of reality, and repairs every disagreement.
 * Runs once at startup, before the daemon serves traffic, and then on every
 * heartbeat tick: reality moves while the daemon runs (a gVisor box exits
 * whole on OOM), and drift only repaired at boot would leave acquire
 * returning corpses and stall the idle scanner until the next restart.
 *
 * The ledger snapshot is deliberately taken before the reality snapshots.
 * acquire brings reality up first and inserts the row second, so any row in
 * this snapshot had its container (and disk, made even earlier) up before
 * the listings below were taken — a row without a container here really
 * lost it. The other order judged rows inserted mid-pass against container
 * listings from before their containers existed, and deleted live sandboxes.
 *
 * Reality wins every disagreement, but reality is container AND disk, and
 * the disk is the sandbox's durable data:
 * - state differs             -> the row records what the container is
 * - container gone, disk kept -> the sandbox is stopped, not dead: the row
 *                                stays and the next acquire rebuilds the
 *                                container from the disk. This is what makes
 *                                a routine `docker container prune`
 *                                survivable instead of silent data loss.
 * - container and disk gone   -> the sandbox truly is gone (an interrupted
 *                                release, a wiped data dir): the row is
 *                                deleted and the user key is free again
 * - container without a row   -> destroyed; without a row it has no user
 *                                key, so nothing could ever reach it
 * - disk owned by nothing     -> removed; leaked disks silently eat the host
 *
 * Every rowed repair happens inside the sandbox's per-key queue slot, and
 * only if the row still shows the state the snapshot decided on: an acquire
 * or release that moved the sandbox in between makes the observation stale,
 * and writing a stale repair would manufacture the very drift this function
 * exists to remove. A busy key is skipped outright — whatever holds it has
 * fresher knowledge — and the next tick sees the settled picture.
 *
 * Orphan destruction takes two strikes at runtime: a container or disk
 * whose acquire is still in flight has no row yet, and killing it would
 * sabotage the very request creating it. Whatever is still unowned on two
 * consecutive passes (a scan interval apart) is genuinely unreachable.
 * `priorSuspects` carries the first strikes between runs; omitting it (at
 * startup, when nothing can be in flight) destroys orphans immediately.
 *
 * Archived rows claim S3, not local reality — anything of theirs still
 * here is an interrupted cleanup (the transition to archived IS the upload
 * confirmation), swept by resuming it: a leftover container is destroyed,
 * a leftover disk removed. Restoring rows with a live restore task are the
 * task's own business and skipped; without one they are crash zombies (the
 * tracker is daemon memory) repaired reality-first — a container means the
 * restore physically finished before the crash, so the ledger records it;
 * no container means a half-restore, whose disk is removed and whose row
 * reverts to archived (the S3 object is intact — the next acquire retries
 * cleanly). The startup run happens before listen, so no request ever
 * observes an unrepaired zombie.
 */
export async function reconcile(
  db: Db,
  executor: Executor,
  locks: KeyedQueue,
  priorSuspects?: ReadonlySet<string>,
  archiver?: { hasLiveRestore(sandboxId: string): boolean },
): Promise<ReconcileResult> {
  const rows = listSandboxes(db);
  const containers = await executor.listContainers();
  const disks = new Set(await executor.listDisks());
  const result: ReconcileResult = {
    repairedStates: 0,
    deletedRows: 0,
    destroyedOrphans: 0,
    removedDisks: 0,
    archivedSwept: 0,
    suspects: [],
  };
  // Everything a disk may legitimately belong to: rows that survive this
  // pass, and containers that still exist afterwards (destroy tears its
  // own disk, so a container's disk is never removed out from under it).
  const owners = new Set<string>();

  // Re-reads the row inside its queue slot and applies the repair only if
  // the state this pass decided on still holds. The slot is the guard:
  // apply may await executor work (the archived sweep destroys), and
  // nothing else touches this sandbox while the slot is held.
  const repairUnderLock = (
    row: SandboxRow,
    apply: () => void | Promise<void>,
  ) =>
    locks.tryRun(row.userKey, async () => {
      const fresh = findBySandboxId(db, row.sandboxId);
      if (fresh && fresh.state === row.state) {
        await apply();
      }
    });

  for (const row of rows) {
    const observed = containers.get(row.sandboxId);
    containers.delete(row.sandboxId);
    if (row.state === 'archived') {
      owners.add(row.sandboxId);
      if (observed !== undefined) {
        await repairUnderLock(row, async () => {
          await executor.destroy(row.sandboxId);
          result.archivedSwept += 1;
        });
      } else if (disks.has(row.sandboxId)) {
        await repairUnderLock(row, async () => {
          await executor.removeDisk(row.sandboxId);
          result.archivedSwept += 1;
        });
      }
      continue;
    }
    if (row.state === 'restoring') {
      owners.add(row.sandboxId);
      if (archiver?.hasLiveRestore(row.sandboxId)) {
        continue; // The task owns this row; what we observe is its mid-work.
      }
      if (observed !== undefined) {
        await repairUnderLock(row, () => {
          overwriteState(db, row.sandboxId, LEDGER_STATE[observed]);
          result.repairedStates += 1;
        });
      } else {
        await repairUnderLock(row, async () => {
          await executor.removeDisk(row.sandboxId);
          overwriteState(db, row.sandboxId, 'archived');
          result.repairedStates += 1;
        });
      }
      continue;
    }
    if (observed !== undefined) {
      owners.add(row.sandboxId);
      if (LEDGER_STATE[observed] !== row.state) {
        await repairUnderLock(row, () => {
          overwriteState(db, row.sandboxId, LEDGER_STATE[observed]);
          result.repairedStates += 1;
        });
      }
    } else if (disks.has(row.sandboxId)) {
      owners.add(row.sandboxId);
      if (row.state !== 'stopped') {
        await repairUnderLock(row, () => {
          overwriteState(db, row.sandboxId, 'stopped');
          result.repairedStates += 1;
        });
      }
    } else {
      await repairUnderLock(row, () => {
        deleteSandbox(db, row.sandboxId);
        result.deletedRows += 1;
      });
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
