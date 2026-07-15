import { ACTIVITY_KINDS, SANDBOX_STATES } from '@dormice/shared';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

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
  /** The key acquire() is idempotent on: one sandbox per external id. */
  externalId: text('external_id').notNull().unique(),
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
   * JSON object of caller labels (string→string), NULL = none. Written by
   * both faces — native acquire/updateMetadata and E2B create — filtered on
   * by the E2B list and echoed everywhere a sandbox view is.
   */
  metadata: text('metadata'),
  /**
   * The E2B surface's columns. All NULL / defaulted for natively-acquired
   * sandboxes — the native lifecycle never reads them.
   */
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
  externalId: text('external_id'),
  sandboxId: text('sandbox_id'),
  detail: text('detail').notNull(),
});

export type ActivityRow = typeof activity.$inferSelect;

/**
 * Per-sandbox metrics history, written by the background sampler every
 * DORMICE_METRICS_SAMPLE_INTERVAL_SECONDS for each measurable (running or
 * paused) sandbox. The daemon keeps this history because it is a
 * compatibility contract — the E2B metrics endpoint slices by start/end —
 * and because nothing outside the ledger can measure per-sandbox; host
 * trends still belong to Prometheus.
 *
 * Two tables, not one: this and fleet_snapshots differ in unit of meaning
 * (one sandbox's resources vs the whole fleet's state counts), retention
 * (DORMICE_METRICS_RETENTION_HOURS vs a fixed 30 days) and deletion path
 * (destroy cascades here, never there).
 *
 * Keyed by sandboxId, not externalId: rebuild replaces the shell but keeps
 * the sandboxId, so history stays continuous across rebuilds; destroy
 * deletes by the same key. No autoincrement id — rows have no "Nth entry"
 * meaning (unlike the activity ring, where id IS the ring position).
 */
export const sandboxMetricsSamples = sqliteTable(
  'sandbox_metrics_samples',
  {
    sandboxId: text('sandbox_id').notNull(),
    /** ISO 8601 UTC. */
    at: text('at').notNull(),
    cpuCount: real('cpu_count').notNull(),
    cpuUsedPct: real('cpu_used_pct').notNull(),
    memUsedBytes: integer('mem_used_bytes').notNull(),
    memTotalBytes: integer('mem_total_bytes').notNull(),
    memCacheBytes: integer('mem_cache_bytes').notNull(),
    diskUsedBytes: integer('disk_used_bytes').notNull(),
    diskTotalBytes: integer('disk_total_bytes').notNull(),
  },
  (table) => [
    // Slice queries and the destroy cascade both hit the (sandbox, time)
    // prefix; retention pruning walks time alone.
    index('sandbox_metrics_samples_sandbox_at_idx').on(
      table.sandboxId,
      table.at,
    ),
    index('sandbox_metrics_samples_at_idx').on(table.at),
  ],
);

export type SandboxMetricsSampleRow = typeof sandboxMetricsSamples.$inferSelect;

/**
 * Fleet state counts over time, one row per sampler tick: the data behind
 * the console's concurrency curve and peak. Owned by no sandbox — destroy
 * never touches it — and kept a fixed 30 days (the dashboard's widest
 * range defines the need; like ACTIVITY_KEEP, nobody tunes the size of an
 * explanation window).
 *
 * Five explicit state columns instead of a JSON blob: the window peak is
 * max(active) in one SQL aggregate, and the stacked chart needs each state
 * addressable. `total` is stored redundantly so readers never re-derive it.
 */
export const fleetSnapshots = sqliteTable('fleet_snapshots', {
  /** ISO 8601 UTC; one row per tick, so time itself is the key. */
  at: text('at').primaryKey(),
  active: integer('active').notNull(),
  frozen: integer('frozen').notNull(),
  stopped: integer('stopped').notNull(),
  archived: integer('archived').notNull(),
  restoring: integer('restoring').notNull(),
  total: integer('total').notNull(),
});

export type FleetSnapshotRow = typeof fleetSnapshots.$inferSelect;

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

/**
 * The daemon's own secrets — one row, fixed id, same singleton pattern as
 * console_account. envdSigningSecret is the HMAC key behind every envd
 * access token and signed file URL. It is deliberately NOT the API token:
 * with an independent key, rotating the token no longer voids in-flight
 * envd tokens and signed URLs, and a future multi-key world has one answer
 * to "which key do we derive from" — this one.
 *
 * Unlike sessionSecret there is no verb that regenerates it, so reading it
 * once at startup is safe. Born lazily on first use (get-or-create), not
 * by migration — a migration cannot mint randomness.
 */
export const daemonSecrets = sqliteTable('daemon_secrets', {
  id: integer('id').primaryKey(),
  envdSigningSecret: text('envd_signing_secret').notNull(),
  createdAt: text('created_at').notNull(),
});

export type DaemonSecretsRow = typeof daemonSecrets.$inferSelect;
