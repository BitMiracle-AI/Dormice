import type { Db } from './db/db';
import { deleteSandbox, transition } from './db/ledger';
import type { SandboxRow } from './db/schema';
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
 */
export async function releaseSandbox(
  db: Db,
  executor: Executor,
  sandboxId: string,
): Promise<void> {
  await executor.destroy(sandboxId);
  deleteSandbox(db, sandboxId);
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
      return transition(db, row.sandboxId, 'active');
    case 'stopped':
      await executor.start(row.sandboxId);
      return transition(db, row.sandboxId, 'active');
    case 'archived':
    case 'restoring':
      // Unreachable today — nothing archives until the S3 archiver lands.
      // If it fires anyway, fail loudly instead of pretending.
      throw new Error(
        `sandbox ${row.sandboxId} is ${row.state}; restore is not implemented yet`,
      );
  }
}
