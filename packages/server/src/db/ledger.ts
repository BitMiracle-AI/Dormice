import type { LifecyclePolicy, SandboxState } from '@dormice/shared';
import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { type SandboxRow, sandboxes } from './schema';

/**
 * The lifecycle state machine. A sandbox only ever moves one rung colder at
 * a time; waking up is a single jump back to active. Everything the idle
 * scanner and acquire() are allowed to do is this table — it is the single
 * arbiter for state changes, enforced in transition().
 */
export const ALLOWED_TRANSITIONS: Record<
  SandboxState,
  readonly SandboxState[]
> = {
  active: ['frozen'],
  frozen: ['active', 'stopped'],
  stopped: ['active', 'archived'],
  archived: ['restoring'],
  restoring: ['active'],
};

export interface CreateSandboxInput {
  /**
   * Supplied by the caller, not generated here: reality moves first (the
   * container is created under this id), then the ledger records it.
   */
  sandboxId: string;
  userKey: string;
  nodeId: string;
  policy: LifecyclePolicy;
}

/** Inserts a new sandbox row in `active` state. Throws if the user key is taken. */
export function createSandbox(db: Db, input: CreateSandboxInput): SandboxRow {
  const now = new Date().toISOString();
  const row: SandboxRow = {
    sandboxId: input.sandboxId,
    userKey: input.userKey,
    state: 'active',
    nodeId: input.nodeId,
    freezeAfterSeconds: input.policy.freezeAfterSeconds,
    stopAfterSeconds: input.policy.stopAfterSeconds,
    archiveAfterSeconds: input.policy.archiveAfterSeconds,
    createdAt: now,
    lastActiveAt: now,
  };
  db.insert(sandboxes).values(row).run();
  return row;
}

/**
 * Refreshes the idle clock. Every acquire() calls this; the idle scanner
 * measures freeze/stop/archive thresholds from lastActiveAt.
 */
export function touch(db: Db, sandboxId: string): SandboxRow {
  const now = new Date().toISOString();
  db.update(sandboxes)
    .set({ lastActiveAt: now })
    .where(eq(sandboxes.sandboxId, sandboxId))
    .run();
  const row = db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.sandboxId, sandboxId))
    .get();
  if (!row) {
    throw new Error(`sandbox ${sandboxId} not found`);
  }
  return row;
}

/** Full table scan — the idle scanner's sweep. Fine at single-machine scale. */
export function listSandboxes(db: Db): SandboxRow[] {
  return db.select().from(sandboxes).all();
}

/**
 * Removes the row entirely. Release is legal from any state, so deletion
 * does not go through ALLOWED_TRANSITIONS — that table governs moves between
 * states, not the end of the record.
 */
export function deleteSandbox(db: Db, sandboxId: string): void {
  db.delete(sandboxes).where(eq(sandboxes.sandboxId, sandboxId)).run();
}

/**
 * Overwrites the state with an observed fact, bypassing ALLOWED_TRANSITIONS:
 * that table governs the moves the daemon plans; the reconciler records what
 * reality already did while nobody was watching. Only the reconciler calls
 * this — everything else goes through transition().
 */
export function overwriteState(
  db: Db,
  sandboxId: string,
  state: SandboxState,
): void {
  db.update(sandboxes)
    .set({ state })
    .where(eq(sandboxes.sandboxId, sandboxId))
    .run();
}

export function findByUserKey(db: Db, userKey: string): SandboxRow | undefined {
  return db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.userKey, userKey))
    .get();
}

export function findBySandboxId(
  db: Db,
  sandboxId: string,
): SandboxRow | undefined {
  return db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.sandboxId, sandboxId))
    .get();
}

/**
 * Moves a sandbox to a new state, enforcing ALLOWED_TRANSITIONS. An illegal
 * transition is a bug in the caller, so it throws instead of self-healing.
 *
 * No lock needed: better-sqlite3 is synchronous and the daemon is a single
 * process, so there is no await point between the read and the write.
 */
export function transition(
  db: Db,
  sandboxId: string,
  to: SandboxState,
): SandboxRow {
  const row = db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.sandboxId, sandboxId))
    .get();
  if (!row) {
    throw new Error(`sandbox ${sandboxId} not found`);
  }
  if (!ALLOWED_TRANSITIONS[row.state].includes(to)) {
    throw new Error(
      `illegal transition ${row.state} -> ${to} (sandbox ${sandboxId})`,
    );
  }
  db.update(sandboxes)
    .set({ state: to })
    .where(eq(sandboxes.sandboxId, sandboxId))
    .run();
  return { ...row, state: to };
}
