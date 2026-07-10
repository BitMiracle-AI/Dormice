import type { LifecyclePolicy, SandboxState } from '@dormice/shared';
import { count, eq } from 'drizzle-orm';
import type { Db } from './db';
import { type SandboxRow, sandboxes } from './schema';

/**
 * The lifecycle state machine. The idle scanner only ever moves one rung
 * colder at a time; waking up is a single jump back to active. The one
 * two-rung move is active -> stopped: rebuild removes a running container
 * outright (the shell is swapped, the disk stays), and there is no paused
 * moment in between to record. This table is the single arbiter for state
 * changes, enforced in transition().
 */
export const ALLOWED_TRANSITIONS: Record<
  SandboxState,
  readonly SandboxState[]
> = {
  active: ['frozen', 'stopped'],
  frozen: ['active', 'stopped'],
  stopped: ['active', 'archived'],
  archived: ['restoring'],
  // The archived edge is the failure edge: a restore that dies reverts —
  // the S3 object is untouched, so the next acquire simply retries.
  restoring: ['active', 'archived'],
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
  /** Template the sandbox is created from; absent/null means the base image. */
  template?: string | null;
  /** E2B-surface extras; native acquire never sets them. */
  e2b?: {
    /** JSON-serialized objects, stored verbatim. */
    metadata: string | null;
    envs: string | null;
    deadlineAt: string;
    onDeadline: 'kill' | 'pause';
  };
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
    template: input.template ?? null,
    createdAt: now,
    lastActiveAt: now,
    metadata: input.e2b?.metadata ?? null,
    envs: input.e2b?.envs ?? null,
    deadlineAt: input.e2b?.deadlineAt ?? null,
    onDeadline: input.e2b?.onDeadline ?? null,
    pausedByUser: false,
  };
  db.insert(sandboxes).values(row).run();
  return row;
}

/**
 * Refreshes the idle clock. Every acquire() calls this; the idle scanner
 * measures freeze/stop/archive thresholds from lastActiveAt. `now` is
 * injectable so tests can travel in time instead of sleeping.
 */
export function touch(
  db: Db,
  sandboxId: string,
  now: string = new Date().toISOString(),
): SandboxRow {
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

/** How many sandboxes exist, for the capacity check at acquire. */
export function countSandboxes(db: Db): number {
  return db.select({ n: count() }).from(sandboxes).get()?.n ?? 0;
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

/**
 * Sets or clears the E2B deadline. Both travel together: a deadline without
 * an action (or the reverse) would be a row the scanner cannot interpret.
 */
export function setDeadline(
  db: Db,
  sandboxId: string,
  deadline: { deadlineAt: string; onDeadline: 'kill' | 'pause' } | null,
): void {
  db.update(sandboxes)
    .set({
      deadlineAt: deadline?.deadlineAt ?? null,
      onDeadline: deadline?.onDeadline ?? null,
    })
    .where(eq(sandboxes.sandboxId, sandboxId))
    .run();
}

/** Marks an explicit E2B pause; wakes clear it (an awake sandbox is not paused). */
export function setPausedByUser(
  db: Db,
  sandboxId: string,
  paused: boolean,
): void {
  db.update(sandboxes)
    .set({ pausedByUser: paused })
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
