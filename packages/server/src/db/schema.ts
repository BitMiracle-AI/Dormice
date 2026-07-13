import { ACTIVITY_KINDS, SANDBOX_STATES } from '@dormice/shared';
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

/**
 * The activity ring: the ledger's recent history, one row per lifecycle
 * event (created, cooled, woken, destroyed, repaired). Bounded by count —
 * recordActivity prunes past the newest N — so it answers "what just
 * happened" without ever becoming a second database to babysit. The
 * autoincrement id is the ring position AND the newest-first sort key;
 * unlike sandbox ids it never leaves this machine, so the UUID rule does
 * not apply.
 */
export const activity = sqliteTable('activity', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** ISO 8601 UTC. */
  at: text('at').notNull(),
  kind: text('kind', { enum: ACTIVITY_KINDS }).notNull(),
  /** Null for events with no owning sandbox (orphan sweeps, daemon start). */
  userKey: text('user_key'),
  sandboxId: text('sandbox_id'),
  detail: text('detail').notNull(),
});

export type ActivityRow = typeof activity.$inferSelect;

/**
 * The console's one human account (the fixed id makes "at most one row" a
 * schema fact, not a convention). The API token stays the root of trust:
 * presenting it (re)creates this row — that IS the forgot-password path —
 * while day-to-day console logins are username + password.
 *
 * sessionSecret is the HMAC key for session cookies. It lives here and not
 * in the token so the two credentials rotate independently: re-running
 * setup regenerates it (every session out — correct for a password reset),
 * rotating the API token leaves console sessions alone.
 */
export const consoleAccount = sqliteTable('console_account', {
  id: integer('id').primaryKey(),
  username: text('username').notNull(),
  /** Self-describing scrypt string: scrypt$N$r$p$<salt b64>$<hash b64>. */
  passwordHash: text('password_hash').notNull(),
  sessionSecret: text('session_secret').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type ConsoleAccountRow = typeof consoleAccount.$inferSelect;
