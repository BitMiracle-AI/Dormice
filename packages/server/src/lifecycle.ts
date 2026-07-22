import { type ArchiveStore, objectKey } from './archive/store';
import { recordActivity } from './db/activity';
import type { Db } from './db/db';
import {
  deleteSandbox,
  findById,
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
 * context ("why"); `actor` is who asked (request.actor's vocabulary) — the
 * daemon's own callers (scanner, reconciler) pass neither, and the honest
 * defaults name the bare move and no credential.
 */
export async function freezeSandbox(
  db: Db,
  executor: Executor,
  sandboxId: string,
  cause?: string,
  actor?: string | null,
): Promise<SandboxRow> {
  await executor.freeze(sandboxId);
  const row = transition(db, sandboxId, 'frozen');
  recordActivity(db, {
    kind: 'frozen',
    sandboxName: row.name,
    sandboxId,
    actor,
    detail: cause ?? 'memory squeezed into swap',
  });
  return row;
}

export async function stopSandbox(
  db: Db,
  executor: Executor,
  sandboxId: string,
  cause?: string,
  actor?: string | null,
): Promise<SandboxRow> {
  await executor.stop(sandboxId);
  const row = transition(db, sandboxId, 'stopped');
  recordActivity(db, {
    kind: 'stopped',
    sandboxName: row.name,
    sandboxId,
    actor,
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
  activity: {
    kind: 'destroyed' | 'expired-killed';
    cause: string;
    actor?: string | null;
  } = {
    kind: 'destroyed',
    cause: 'via destroySandbox',
  },
): Promise<void> {
  const row = findById(db, sandboxId);
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
      sandboxName: row.name,
      sandboxId,
      actor: activity.actor,
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
      sandboxName: row.name,
      sandboxId,
      actor: activity.actor,
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
 * without losing a byte of /home/user — immediately, without waiting for
 * the next wake's own stale-shell convergence (wakeSandbox). Already-stopped
 * rows skip the ledger write: removing a pruned-away container is a no-op
 * and stopped -> stopped is not a transition.
 */
export async function rebuildSandbox(
  db: Db,
  executor: Executor,
  row: SandboxRow,
  actor?: string | null,
  detail?: string,
): Promise<SandboxRow> {
  await executor.removeContainer(row.id);
  recordActivity(db, {
    kind: 'rebuilt',
    sandboxName: row.name,
    sandboxId: row.id,
    actor,
    detail:
      detail ??
      'shell removed, disk kept — next wake builds from the current image',
  });
  if (row.state === 'stopped') {
    return row;
  }
  return transition(db, row.id, 'stopped');
}

/**
 * Brings a sandbox in any cold state back to active. No-op when already
 * active.
 *
 * Every cold wake first converges the shell onto the template's *current*
 * image — the same verdict listSandboxImages calls `upgradable` (imageOf
 * against resolveImage ?? baseImage; a null imageOf is not stale: a shell
 * that does not exist boots the current image by itself). A stale shell is
 * swapped through rebuildSandbox — removed, ledger to stopped — and the
 * stopped arm builds the new one; a fresh shell keeps its millisecond
 * unpause / restart path untouched. This is what makes `dor template add`
 * reach existing sandboxes: without it a frozen or stopped shell revives
 * as-is and the fleet never upgrades short of a manual rebuildSandbox
 * (which stays the front door for "swap now, don't wait for a wake").
 *
 * The honest cost: a frozen sandbox is a paused container — its processes
 * and memory are alive — and the swap kills them for a cold start. That is
 * within the crash-only contract (code must survive the container
 * vanishing anyway) and only ever triggered by an operator deliberately
 * re-registering the template.
 */
export async function wakeSandbox(
  db: Db,
  executor: Executor,
  row: SandboxRow,
  actor?: string | null,
): Promise<SandboxRow> {
  switch (row.state) {
    case 'active':
      return row;
    case 'frozen':
    case 'stopped': {
      const next = resolveImage(db, row.template) ?? executor.baseImage;
      const born = await executor.imageOf(row.id);
      const fresh =
        born !== null && born !== next
          ? await rebuildSandbox(
              db,
              executor,
              row,
              actor,
              `stale shell swapped at wake: ${born} -> ${next}`,
            )
          : row;
      if (fresh.state === 'frozen') {
        await executor.unfreeze(fresh.id);
        return awaken(
          db,
          fresh,
          'from frozen (memory back out of swap)',
          actor,
        );
      }
      // If no container object exists (pruned away, or the stale shell was
      // just removed), start rebuilds it from the current image.
      await executor.start(fresh.id, {
        image: resolveImage(db, fresh.template),
      });
      return awaken(db, fresh, 'cold start from the surviving disk', actor);
    }
    case 'archived':
    case 'restoring':
      // Every legitimate path branches to the archiver before landing here
      // (acquire begins a restore, the E2B surface joins one); reaching
      // this arm is a caller bug worth hearing loudly.
      throw new Error(
        `sandbox ${row.id} is ${row.state}; restore goes through the archiver — this wake is a caller bug`,
      );
  }
}

/**
 * The ledger side of a wake. An awake sandbox is by definition not paused,
 * so any explicit E2B pause mark is cleared along with the transition —
 * ledger honesty, not an E2B-surface concern leaking in.
 */
function awaken(
  db: Db,
  row: SandboxRow,
  how: string,
  actor?: string | null,
): SandboxRow {
  if (row.pausedByUser) {
    setPausedByUser(db, row.id, false);
  }
  const awake = transition(db, row.id, 'active');
  recordActivity(db, {
    kind: 'woken',
    sandboxName: row.name,
    sandboxId: row.id,
    actor,
    detail: how,
  });
  return { ...awake, pausedByUser: false };
}
