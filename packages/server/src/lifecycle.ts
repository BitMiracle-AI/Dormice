import { type ArchiveStore, objectKey } from './archive/store';
import { recordActivity } from './db/activity';
import type { Db } from './db/db';
import {
  deleteSandbox,
  findBySandboxId,
  setPausedByUser,
  transition,
} from './db/ledger';
import { deleteSandboxMetricsSamples } from './db/metrics';
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

/**
 * The lifecycle verbs also feed the activity ring here, after the ledger
 * write — history is recorded where reality and ledger already move
 * together, so no caller can forget it. `cause` is the caller's one line of
 * context ("who did this and why"); the default names the bare move.
 */
export async function freezeSandbox(
  db: Db,
  executor: Executor,
  sandboxId: string,
  cause?: string,
): Promise<SandboxRow> {
  await executor.freeze(sandboxId);
  const row = transition(db, sandboxId, 'frozen');
  recordActivity(db, {
    kind: 'frozen',
    externalId: row.externalId,
    sandboxId,
    detail: cause ?? 'memory squeezed into swap',
  });
  return row;
}

export async function stopSandbox(
  db: Db,
  executor: Executor,
  sandboxId: string,
  cause?: string,
): Promise<SandboxRow> {
  await executor.stop(sandboxId);
  const row = transition(db, sandboxId, 'stopped');
  recordActivity(db, {
    kind: 'stopped',
    externalId: row.externalId,
    sandboxId,
    detail: cause ?? 'container torn down, disk kept',
  });
  return row;
}

/**
 * The end of a sandbox's life: container and disk destroyed, row removed.
 * Same order as everything else — reality first, ledger second; a crash in
 * between leaves a row pointing at nothing, which is the reconciler's kind
 * of drift, not this caller's.
 *
 * An archived sandbox's body is its S3 object — nothing physical exists
 * locally, so destroy deletes the object instead of calling destroy (which
 * would honestly throw at the double absence). Every caller passes the
 * store explicitly (null = no archiver configured): releasing an archived
 * row without a store fails loudly and keeps the row, retryable once the
 * operator restores the DORMICE_S3_* configuration.
 */
export async function destroySandbox(
  db: Db,
  executor: Executor,
  sandboxId: string,
  store: ArchiveStore | null,
  activity: { kind: 'destroyed' | 'expired-killed'; cause: string } = {
    kind: 'destroyed',
    cause: 'via destroySandbox',
  },
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
    // With the disk gone its metrics history has no owner; fleet snapshots
    // belong to no sandbox and stay.
    deleteSandboxMetricsSamples(db, sandboxId);
    recordActivity(db, {
      kind: activity.kind,
      externalId: row.externalId,
      sandboxId,
      detail: `${activity.cause}; archive object deleted`,
    });
    return;
  }
  await executor.destroy(sandboxId);
  deleteSandbox(db, sandboxId);
  deleteSandboxMetricsSamples(db, sandboxId);
  if (row) {
    recordActivity(db, {
      kind: activity.kind,
      externalId: row.externalId,
      sandboxId,
      detail: activity.cause,
    });
  }
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
  recordActivity(db, {
    kind: 'rebuilt',
    externalId: row.externalId,
    sandboxId: row.sandboxId,
    detail:
      'shell removed, disk kept — next wake builds from the current image',
  });
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
      return awaken(db, row, 'from frozen (memory back out of swap)');
    case 'stopped':
      // If the container object was pruned away, start rebuilds the shell —
      // from the template's current image, resolved here at wake time.
      await executor.start(row.sandboxId, {
        image: resolveImage(db, row.template),
      });
      return awaken(db, row, 'cold start from the surviving disk');
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
function awaken(db: Db, row: SandboxRow, how: string): SandboxRow {
  if (row.pausedByUser) {
    setPausedByUser(db, row.sandboxId, false);
  }
  const awake = transition(db, row.sandboxId, 'active');
  recordActivity(db, {
    kind: 'woken',
    externalId: row.externalId,
    sandboxId: row.sandboxId,
    detail: how,
  });
  return { ...awake, pausedByUser: false };
}
