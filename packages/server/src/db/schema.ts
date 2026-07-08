import { SANDBOX_STATES } from '@dormice/shared';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The ledger. SQLite is the ledger, Docker is reality, and the daemon's core
 * job is keeping the two in agreement — every sandbox the daemon knows about
 * is a row here, and `state` is what the daemon believes about reality.
 *
 * Timestamps are ISO 8601 UTC strings: one format end to end (protocol, DB,
 * logs), and lexicographic order equals chronological order.
 */
export const sandboxes = sqliteTable('sandboxes', {
  /** UUID, never an autoincrement — ids must stay unique across machines. */
  sandboxId: text('sandbox_id').primaryKey(),
  /** The key acquire() is idempotent on: one sandbox per user key. */
  userKey: text('user_key').notNull().unique(),
  state: text('state', { enum: SANDBOX_STATES }).notNull(),
  nodeId: text('node_id').notNull(),
  freezeAfterSeconds: integer('freeze_after_seconds').notNull(),
  /** NULL means never stop: the sandbox parks frozen forever. */
  stopAfterSeconds: integer('stop_after_seconds'),
  /** NULL means never archive. */
  archiveAfterSeconds: integer('archive_after_seconds'),
  createdAt: text('created_at').notNull(),
  lastActiveAt: text('last_active_at').notNull(),
});

export type SandboxRow = typeof sandboxes.$inferSelect;
