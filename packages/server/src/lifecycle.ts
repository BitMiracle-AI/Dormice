import type { ShellExitCause } from '@dormice/shared';
import { type ArchiveStore, objectKey } from './archive/store';
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
 * The verbs return the row they left behind and say nothing themselves:
 * the caller with a logger (a route's request log, the heartbeat's
 * summary in main.ts) is the one that speaks. The activity ring that once
 * recorded every move here went with design record #16 (2026-09-13): a
 * bounded SQLite history nobody queried, replaced by the daemon's own
 * structured log in journald.
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
  watchers?: WatcherTable,
): Promise<SandboxRow> {
  await executor.stop(sandboxId);
  watchers?.disposeSandbox(sandboxId);
  return transition(db, sandboxId, 'stopped');
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
    return;
  }
  await executor.destroy(sandboxId);
  watchers?.disposeSandbox(sandboxId);
  deleteSandbox(db, sandboxId);
  deleteSandboxMetricsSamples(db, sandboxId);
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

/**
 * A shell that stopped under a row that never ordered a stop — a death. The
 * one place it is recorded, whoever noticed: the reconciler's heartbeat
 * (an idle sandbox nobody touches) or a wake that found the shell dead (a
 * busy one, whose caller is about to use it). Both write the same two
 * facts — state stopped and lastExit — so the console and the wire tell
 * one story. Watchers are disposed here too: a dead container has ended
 * every inotifywait it hosted. Only the observation is recorded: the cold
 * start a wake goes on to attempt is its own move once it has actually
 * happened, never a claim made ahead of it. lastExit.at is the runtime's
 * record of the exit (the death itself), which is why the row can say
 * when a sandbox died even when the reconciler only found it a heartbeat
 * later.
 */
export function recordShellDeath(
  db: Db,
  row: SandboxRow,
  exit: ShellExit,
  watchers?: WatcherTable,
): void {
  watchers?.disposeSandbox(row.id);
  writeShellDeath(db, row.id, {
    at: exit.finishedAt,
    exitCode: exit.exitCode,
    cause: causeOfExit(exit),
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
  watchers?: WatcherTable,
): Promise<SandboxRow> {
  await executor.removeContainer(row.id);
  watchers?.disposeSandbox(row.id);
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
      recordShellDeath(db, row, exit, watchers);
      const dead = findById(db, row.id);
      if (dead === undefined) {
        throw new Error(`sandbox ${row.id} vanished while recording its death`);
      }
      return wakeSandbox(db, executor, dead, watchers);
    }
    case 'frozen':
    case 'stopped': {
      const next = resolveImage(db, row.template) ?? executor.baseImage();
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
      const stale =
        (born !== null && born !== next) ||
        (limits !== null &&
          (limits.nanoCpus !== wantNanoCpus ||
            limits.memoryBytes !== wantMemoryBytes));
      const fresh = stale
        ? await rebuildSandbox(db, executor, row, watchers)
        : row;
      if (fresh.state === 'frozen') {
        await executor.unfreeze(fresh.id);
        await watchers?.reapDeferred(fresh.id);
        return awaken(db, fresh);
      }
      // If no container object exists (pruned away, or the stale shell was
      // just removed), start rebuilds it from the current image and the
      // row's own spec (absent knobs fall to the executor's live default).
      await executor.start(fresh.id, {
        image: resolveImage(db, fresh.template),
        ...shellSpecOf(fresh),
      });
      await watchers?.reapDeferred(fresh.id);
      return awaken(db, fresh);
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
function awaken(db: Db, row: SandboxRow): SandboxRow {
  if (row.pausedByUser) {
    setPausedByUser(db, row.id, false);
  }
  const awake = transition(db, row.id, 'active');
  return { ...awake, pausedByUser: false };
}
