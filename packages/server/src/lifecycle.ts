import { type ArchiveStore, objectKey } from './archive/store';
import type { Db } from './db/db';
import {
  deleteSandbox,
  findBySandboxId,
  setPausedByUser,
  transition,
} from './db/ledger';
import type { SandboxRow } from './db/schema';
import { resolveImage } from './db/templates';
import type { Executor } from './executor/executor';

/**
 * Every physical lifecycle change goes through this module, so the container
 * action and the ledger transition always travel together — the single
 * arbiter for "reality and ledger move as one".
 *
 * Order is always reality first, ledger second: the ledger records facts, it
 * does not declare intentions. If the daemon crashes between the two, the
 * ledger is merely stale; spotting and repairing that drift is a future
 * reconciler's job, not something every caller hedges against.
 */

export async function freezeSandbox(
  db: Db,
  executor: Executor,
  sandboxId: string,
): Promise<SandboxRow> {
  await executor.freeze(sandboxId);
  return transition(db, sandboxId, 'frozen');
}

export async function stopSandbox(
  db: Db,
  executor: Executor,
  sandboxId: string,
): Promise<SandboxRow> {
  await executor.stop(sandboxId);
  return transition(db, sandboxId, 'stopped');
}

/**
 * The end of a sandbox's life: container and disk destroyed, row removed.
 * Same order as everything else — reality first, ledger second; a crash in
 * between leaves a row pointing at nothing, which is the reconciler's kind
 * of drift, not this caller's.
 *
 * An archived sandbox's body is its S3 object — nothing physical exists
 * locally, so release deletes the object instead of calling destroy (which
 * would honestly throw at the double absence). Every caller passes the
 * store explicitly (null = no archiver configured): releasing an archived
 * row without a store fails loudly and keeps the row, retryable once the
 * operator restores the DORMICE_S3_* configuration.
 */
export async function releaseSandbox(
  db: Db,
  executor: Executor,
  sandboxId: string,
  store: ArchiveStore | null,
): Promise<void> {
  const row = findBySandboxId(db, sandboxId);
  if (row?.state === 'archived') {
    if (store === null) {
      throw new Error(
        `sandbox ${sandboxId} is archived but the daemon has no S3 configured (DORMICE_S3_*) — its archive object cannot be deleted`,
      );
    }
    await store.delete(objectKey(sandboxId));
    deleteSandbox(db, sandboxId);
    return;
  }
  await executor.destroy(sandboxId);
  deleteSandbox(db, sandboxId);
}

/**
 * Swap the shell, keep the body: the container is removed (whatever state),
 * the disk stays, and the ledger records `stopped` — the state whose wake
 * path builds a fresh container from the surviving disk, and therefore from
 * the *current* image of the sandbox's template (or the daemon's current
 * base image). This is how an existing sandbox picks up new shared layers
 * without losing a byte of /home/user. Already-stopped rows skip the ledger
 * write: removing a pruned-away container is a no-op and stopped -> stopped
 * is not a transition.
 */
export async function rebuildSandbox(
  db: Db,
  executor: Executor,
  row: SandboxRow,
): Promise<SandboxRow> {
  await executor.removeContainer(row.sandboxId);
  if (row.state === 'stopped') {
    return row;
  }
  return transition(db, row.sandboxId, 'stopped');
}

/** Brings a sandbox in any cold state back to active. No-op when already active. */
export async function wakeSandbox(
  db: Db,
  executor: Executor,
  row: SandboxRow,
): Promise<SandboxRow> {
  switch (row.state) {
    case 'active':
      return row;
    case 'frozen':
      await executor.unfreeze(row.sandboxId);
      return awaken(db, row);
    case 'stopped':
      // If the container object was pruned away, start rebuilds the shell —
      // from the template's current image, resolved here at wake time.
      await executor.start(row.sandboxId, {
        image: resolveImage(db, row.template),
      });
      return awaken(db, row);
    case 'archived':
    case 'restoring':
      // Every legitimate path branches to the archiver before landing here
      // (acquire begins a restore, the E2B surface joins one); reaching
      // this arm is a caller bug worth hearing loudly.
      throw new Error(
        `sandbox ${row.sandboxId} is ${row.state}; restore goes through the archiver — this wake is a caller bug`,
      );
  }
}

/**
 * The ledger side of a wake. An awake sandbox is by definition not paused,
 * so any explicit E2B pause mark is cleared along with the transition —
 * ledger honesty, not an E2B-surface concern leaking in.
 */
function awaken(db: Db, row: SandboxRow): SandboxRow {
  if (row.pausedByUser) {
    setPausedByUser(db, row.sandboxId, false);
  }
  return { ...transition(db, row.sandboxId, 'active'), pausedByUser: false };
}
