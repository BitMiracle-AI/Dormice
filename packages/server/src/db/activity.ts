import type { ActivityKind } from '@dormice/shared';
import { desc, lte } from 'drizzle-orm';
import type { Db } from './db';
import { type ActivityRow, activity } from './schema';

/**
 * How much history the ring keeps. Not a knob: nobody sizes an explanation
 * window, and a bound this generous covers days of a busy single machine —
 * anyone needing more than "what just happened" needs a real audit trail,
 * which this deliberately is not.
 */
export const ACTIVITY_KEEP = 1000;

export interface ActivityInput {
  kind: ActivityKind;
  /** The owning sandbox's name/id — prefixed: they reference another entity. */
  sandboxName?: string | null;
  sandboxId?: string | null;
  detail: string;
}

/**
 * Appends one event and prunes the ring in the same breath. Synchronous
 * like every ledger write, and deliberately unguarded: if the ledger can
 * record state, it can record history — a failure here is the same disk
 * catastrophe that would fail the transition itself.
 */
export function recordActivity(db: Db, input: ActivityInput): void {
  const inserted = db
    .insert(activity)
    .values({
      at: new Date().toISOString(),
      kind: input.kind,
      sandboxName: input.sandboxName ?? null,
      sandboxId: input.sandboxId ?? null,
      detail: input.detail,
    })
    .run();
  db.delete(activity)
    .where(lte(activity.id, Number(inserted.lastInsertRowid) - ACTIVITY_KEEP))
    .run();
}

/** Newest first — the question is always "what just happened". */
export function listActivityEvents(db: Db, limit: number): ActivityRow[] {
  return db
    .select()
    .from(activity)
    .orderBy(desc(activity.id))
    .limit(limit)
    .all();
}
