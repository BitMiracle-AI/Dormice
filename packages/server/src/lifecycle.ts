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
import { readRuntimeSettings } from './db/settings';
import { resolveImage } from './db/templates';
import type { WatcherTable } from './e2b/watcher-table';
import type { Executor } from './executor/executor';
import { resolveSpec, shellSpecOf } from './spec';

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
  watchers?: WatcherTable,
): Promise<SandboxRow> {
  await executor.stop(sandboxId);
  watchers?.disposeSandbox(sandboxId);
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
 * store explicitly (null = no archive store configured): releasing an
 * archived row without a store fails loudly and keeps the row, retryable
 * once the operator configures the store again (console settings).
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
  watchers?: WatcherTable,
): Promise<void> {
  const row = findById(db, sandboxId);
  if (row?.state === 'archived') {
    if (store === null) {
      throw new Error(
        `sandbox ${sandboxId} is archived but no S3 archive store is configured — its archive object cannot be deleted`,
      );
    }
    await store.delete(objectKey(sandboxId));
    watchers?.disposeSandbox(sandboxId);
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
  watchers?.disposeSandbox(sandboxId);
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
  watchers?: WatcherTable,
): Promise<SandboxRow> {
  await executor.removeContainer(row.id);
  watchers?.disposeSandbox(row.id);
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
 * image AND the CPU/memory spec in force — one verdict over the (image,
 * limits) tuple, because both are properties of the shell, fixed at its
 * birth. Image: imageOf against resolveImage ?? baseImage — the same
 * verdict listSandboxImages calls `upgradable` (a null imageOf is not
 * stale: a shell that does not exist boots the current image and spec by
 * itself). Limits: limitsOf against the ledger's resolved spec, compared
 * in the runtime's own integer units so no float drift can fake a
 * mismatch. A stale shell is swapped through rebuildSandbox — removed,
 * ledger to stopped — and the stopped arm builds the new one; a matching
 * shell keeps its millisecond unpause / restart path untouched. This is
 * what makes `dor template add` — and now updateSpec, and a console edit
 * of the global defaults — reach existing sandboxes: without it a frozen
 * shell revives as-is (unpause rebuilds nothing) and a spec change would
 * never take effect short of a manual rebuildSandbox (which stays the
 * front door for "swap now, don't wait for a wake").
 *
 * The honest cost: a frozen sandbox is a paused container — its processes
 * and memory are alive — and the swap kills them for a cold start. That is
 * within the crash-only contract (code must survive the container
 * vanishing anyway) and only ever triggered by an operator deliberately
 * re-registering the template or resizing the spec.
 */
export async function wakeSandbox(
  db: Db,
  executor: Executor,
  row: SandboxRow,
  actor?: string | null,
  watchers?: WatcherTable,
): Promise<SandboxRow> {
  switch (row.state) {
    case 'active':
      await watchers?.reapDeferred(row.id);
      return row;
    case 'frozen':
    case 'stopped': {
      const next = resolveImage(db, row.template) ?? executor.baseImage;
      const born = await executor.imageOf(row.id);
      // The spec in force, in the runtime's integer units — what a shell
      // built right now would be born with.
      const spec = resolveSpec(row, readRuntimeSettings(db).sandboxDefaults);
      const wantNanoCpus = Math.round(spec.cpus * 1e9);
      const wantMemoryBytes = Math.round(spec.memoryGb * 1024 ** 3);
      const limits = born !== null ? await executor.limitsOf(row.id) : null;
      const staleCause =
        born !== null && born !== next
          ? `stale shell swapped at wake: ${born} -> ${next}`
          : limits !== null &&
              (limits.nanoCpus !== wantNanoCpus ||
                limits.memoryBytes !== wantMemoryBytes)
            ? `stale shell swapped at wake: limits ${limits.nanoCpus / 1e9} cpus / ${limits.memoryBytes / 1024 ** 3} GiB -> ${spec.cpus} cpus / ${spec.memoryGb} GiB`
            : null;
      const fresh =
        staleCause !== null
          ? await rebuildSandbox(db, executor, row, actor, staleCause, watchers)
          : row;
      if (fresh.state === 'frozen') {
        await executor.unfreeze(fresh.id);
        await watchers?.reapDeferred(fresh.id);
        return awaken(
          db,
          fresh,
          'from frozen (memory back out of swap)',
          actor,
        );
      }
      // If no container object exists (pruned away, or the stale shell was
      // just removed), start rebuilds it from the current image and the
      // row's own spec (absent knobs fall to the executor's live default).
      await executor.start(fresh.id, {
        image: resolveImage(db, fresh.template),
        ...shellSpecOf(fresh),
      });
      await watchers?.reapDeferred(fresh.id);
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
