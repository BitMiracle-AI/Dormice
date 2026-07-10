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
  /**
   * Template the sandbox was created from; NULL means the base image. The
   * name is recorded, not the image it pointed at when the sandbox was born:
   * shells are rebuilt from the template's *current* image — the same rule
   * that already governs the base image.
   */
  template: text('template'),
  createdAt: text('created_at').notNull(),
  lastActiveAt: text('last_active_at').notNull(),
  /**
   * The E2B surface's columns. All NULL / defaulted for natively-acquired
   * sandboxes — the native lifecycle never reads them.
   */
  /** JSON object; E2B metadata, persisted for list filtering and echo. */
  metadata: text('metadata'),
  /** JSON object; sandbox-level default envs, merged under per-command envs. */
  envs: text('envs'),
  /** ISO 8601; the E2B timeout's absolute deadline. NULL = no deadline. */
  deadlineAt: text('deadline_at'),
  /** What the scanner does when deadlineAt passes. Non-null iff deadlineAt is. */
  onDeadline: text('on_deadline', { enum: ['kill', 'pause'] }),
  /**
   * Explicitly paused through the E2B surface and not woken since. Only
   * consulted by the logical-state view; every wake back to active clears it.
   */
  pausedByUser: integer('paused_by_user', { mode: 'boolean' })
    .notNull()
    .default(false),
});

export type SandboxRow = typeof sandboxes.$inferSelect;

/**
 * Registered templates: a name for a Docker image that lives on this host.
 * The host's Docker daemon is the image store; this table only records which
 * name points where. Sandboxes reference templates by name (column above),
 * so re-pointing a name upgrades every future shell built for it.
 */
export const templates = sqliteTable('templates', {
  name: text('name').primaryKey(),
  image: text('image').notNull(),
  createdAt: text('created_at').notNull(),
});

export type TemplateRow = typeof templates.$inferSelect;
