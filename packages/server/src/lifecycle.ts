import type { ShellExitCause } from '@dormice/shared';
import { type ArchiveStore, objectKey } from './archive/store';
import { recordActivity } from './db/activity';
import type { Db } from './db/db';
import {
  deleteSandbox,
  findById,
  setPausedByUser,
  transition,
  writeShellDeath,
} from './db/ledger';
import { deleteSandboxMetricsSamples } from './db/metrics';
import type { SandboxRow } from './db/schema';
import { readRuntimeSettings } from './db/settings';
import { resolveImage } from './db/templates';
import type { WatcherTable } from './e2b/watcher-table';
import type { Executor, ShellExit } from './executor/executor';
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
 * The wire's verdict on a death, from the executor's reading of the exit.
 * Only the memory-cgroup OOM is asserted as a cause — Docker relays it
 * straight from the kernel. The runtime's own death (ShellExit.runtimeDied
 * — under gVisor, exit 2 without the OOM flag) is the signature a pids-cap
 * hit leaves: a strong hint, named as such. Everything else is a bare exit.
 */
export function causeOfExit(exit: ShellExit): ShellExitCause {
  if (exit.oomKilled) return 'oom-killed';
  if (exit.runtimeDied) return 'runtime-died';
  return 'exited';
}

/** The same three verdicts in the words the activity feed uses. */
export function describeExit(exit: ShellExit): string {
  const cause = causeOfExit(exit);
  if (cause === 'oom-killed') {
    return ` (exit ${exit.exitCode}, OOM-killed by the kernel's memory cgroup)`;
  }
  if (cause === 'runtime-died') {
    return ` (exit ${exit.exitCode}, not an OOM kill — gVisor's sentry itself died, the signature a pids-cap hit leaves; see the sandbox pids cap in settings)`;
  }
  return ` (exit ${exit.exitCode}, not an OOM kill)`;
}

/**
 * A shell that stopped under a row that never ordered a stop — a death. The
 * one place it is recorded, whoever noticed: the reconciler's heartbeat
 * (an idle sandbox nobody touches) or a wake that found the shell dead (a
 * busy one, whose caller is about to use it). Both write the same three
 * facts — state stopped, lastExit, a `reconciled` event carrying the
 * exit — so the console, the wire and the activity feed tell one story.
 * Watchers are disposed here too: a dead container has ended every
 * inotifywait it hosted. `noticed` names the observer in the detail, the
 * only thing that differs between the two — and only the observation is
 * recorded here: the cold start a wake goes on to attempt is its own
 * `woken` event once it has actually happened, never a claim made ahead
 * of it. lastExit.at is the runtime's record of the exit (the death
 * itself), which is why the row can say when a sandbox died even when the
 * reconciler only found it a heartbeat later.
 */
export function recordShellDeath(
  db: Db,
  row: SandboxRow,
  exit: ShellExit,
  noticed: 'by the reconciler' | 'at wake',
  watchers?: WatcherTable,
): void {
  watchers?.disposeSandbox(row.id);
  writeShellDeath(db, row.id, {
    at: exit.finishedAt,
    exitCode: exit.exitCode,
    cause: causeOfExit(exit),
  });
  recordActivity(db, {
    kind: 'reconciled',
    sandboxName: row.name,
    sandboxId: row.id,
    detail: `container is stopped — state ${row.state} corrected to stopped${describeExit(exit)}${noticed === 'at wake' ? ', found dead at wake' : ''}`,
  });
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
    case 'active': {
      // The ledger says running; reality may have moved since the last
      // heartbeat — a gVisor box exits whole on OOM or a pids-cap hit, and
      // the reconciler only looks once an interval. A `ready` answered from
      // the ledger alone would hand the caller a corpse (its very next envd
      // call fails "container is stopped"; measured by a consumer: every
      // such failure landed within 120s of a death, i.e. inside the
      // heartbeat's blind spot). One inspect here (~1-2 ms on the local
      // socket, a fraction of the exec that follows) makes `ready` a
      // statement about the container, not the ledger. exitOf answers only
      // for a stopped shell (waiting out the runtime's own few hundred ms
      // of lag when the processes are already dead — the caller who saw
      // its stream end and asks at once is always inside that lag): a live
      // one is null and takes the fast path
      // unchanged; a dead one is recorded as the death it is and falls
      // through to the stopped arm's cold start — the same seconds a
      // stopped sandbox always costs, no `restoring` detour. The one shape
      // this does not cover is a shell that is *gone* (also null): only an
      // operator's prune or rm reaches a live-row container, and the
      // reconciler's next pass records that as stopped-with-disk.
      const exit = await executor.exitOf(row.id);
      if (exit === null) {
        await watchers?.reapDeferred(row.id);
        return row;
      }
      recordShellDeath(db, row, exit, 'at wake', watchers);
      const dead = findById(db, row.id);
      if (dead === undefined) {
        throw new Error(`sandbox ${row.id} vanished while recording its death`);
      }
      return wakeSandbox(db, executor, dead, actor, watchers);
    }
    case 'frozen':
    case 'stopped': {
      const next = resolveImage(db, row.template) ?? executor.baseImage;
      const born = await executor.imageOf(row.id);
      // The spec in force, in the runtime's integer units — what a shell
      // built right now would be born with.
      const spec = resolveSpec(row, readRuntimeSettings(db).sandboxDefaults);
      const wantNanoCpus = Math.round(spec.cpus * 1e9);
      const wantMemoryBytes = Math.round(spec.memoryGb * 1024 ** 3);
      // Consulted only when the image already matches: a shell stale by
      // image is swapped regardless of what limits it was born with.
      const limits =
        born !== null && born === next ? await executor.limitsOf(row.id) : null;
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
