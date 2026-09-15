import { SANDBOX_STATES, SHELL_EXIT_CAUSES } from '@dormice/shared';
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
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
  id: text('id').primaryKey(),
  /** The caller-chosen name acquire() is idempotent on: one sandbox per name. */
  name: text('name').notNull().unique(),
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
  /**
   * Per-sandbox resource spec, the policy columns' sibling: flat columns,
   * NULL = follow the global default (runtime_settings.sandbox_*) — so a
   * console edit of the fleet-wide knob keeps reaching every sandbox that
   * never asked for its own number. cpus/memoryGb are realized at shell
   * birth (the cold-wake convergence swaps a shell whose limits drifted);
   * diskGb at disk birth (restore) and by expandDisk, the one sanctioned
   * grow-only resize.
   */
  cpus: real('cpus'),
  memoryGb: real('memory_gb'),
  diskGb: real('disk_gb'),
  createdAt: text('created_at').notNull(),
  lastActiveAt: text('last_active_at').notNull(),
  /**
   * The shell's last unordered death (shared lastExitSchema): the three
   * travel together — all NULL until a death is recorded, then overwritten
   * only by the next one. Written at exactly one place (lifecycle's
   * recordShellDeath) from the two readers of a stopped shell that nobody
   * stopped: the reconciler's heartbeat and a wake that found it dead.
   */
  lastExitAt: text('last_exit_at'),
  lastExitCode: integer('last_exit_code'),
  lastExitCause: text('last_exit_cause', { enum: SHELL_EXIT_CAUSES }),
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
 * Templates: a name for a Docker image that lives on this host. The host's
 * Docker daemon is the image store; this table only records which name
 * points where. Sandboxes reference templates by name (column above), so
 * re-pointing a name upgrades every future shell built for it.
 *
 * Since the configuration moved to the gateway (2026-09-14) this table is
 * the node's copy: registered and removed there, written here whole with
 * every configuration bundle (db/settings.ts applyNodeConfig) and read at
 * every birth and wake — so a node whose gateway is away still resolves
 * its names.
 */
export const templates = sqliteTable('templates', {
  name: text('name').primaryKey(),
  image: text('image').notNull(),
  createdAt: text('created_at').notNull(),
  /** Bumped only when the image actually changes — see registerTemplate. */
  updatedAt: text('updated_at').notNull(),
});

export type TemplateRow = typeof templates.$inferSelect;

/**
 * Per-sandbox metrics history, written by the background sampler every
 * DORMICE_METRICS_SAMPLE_INTERVAL_SECONDS for each measurable (running or
 * paused) sandbox. The daemon keeps this history because it is a
 * compatibility contract — the E2B metrics endpoint slices by start/end —
 * and because nothing outside the ledger can measure per-sandbox.
 *
 * Two tables, not one: this and host_metrics_samples differ in unit of
 * meaning (one sandbox's resources vs the machine's own), retention
 * (DORMICE_METRICS_RETENTION_HOURS vs a fixed 30 days) and deletion path
 * (destroy cascades here, never there). The fleet's state counts are the
 * gateway's table since the third cut (fleet_snapshots below is the
 * legacy).
 *
 * Keyed by the sandbox's platform id, not its name: rebuild replaces the
 * shell but keeps the id, so history stays continuous across rebuilds;
 * destroy deletes by the same key. No autoincrement id of its own — rows
 * have no "Nth entry" meaning (unlike the activity ring, where id IS the
 * ring position).
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
    /** Nullable: rows sampled before 2026-09-09, and hosts without swap accounting. */
    swapUsedBytes: integer('swap_used_bytes'),
    swapTotalBytes: integer('swap_total_bytes'),
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
 * LEGACY, read by nothing on the node since the third cut (2026-09-15):
 * the fleet's state counts per sampler tick, as this node sampled them
 * while it was a product of its own. The fleet's history is the gateway's
 * table now (gateway db/schema.ts fleet_state_samples, summed over every
 * node at each check-in), and the sampler writes here no more. The table
 * and its rows stay until the fourth cut's import tool has carried a
 * production node's last 30 days into the gateway — a single-node fleet's
 * history is the same figure — so the console's 30-day curve does not
 * break at the cut-over; the DROP ships with that import, beside
 * api_keys and console_account. Not a bug to delete early: the import
 * reads it.
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
 * The host machine's own resource history, one row per sampler tick — the
 * historical sibling of getHostMetrics' snapshot. The original ruling
 * ("host trends belong to Prometheus") was overturned 2026-07-21: on a
 * self-hosted single box nobody runs Prometheus, and overcommit-by-
 * observation — the platform's own capacity story — is impossible without
 * a peak to look at. Owned by no sandbox (destroy never touches it), kept
 * a fixed 30 days: the dashboard's widest range defines the need.
 *
 * Nullable columns are honest platform gaps, never zeros: cpu_used_pct is
 * null on the tick after a daemon start (a delta needs two samples), swap
 * is null where /proc/meminfo does not exist (Mac dev box), disk is null
 * until the data directory does (fake executor, fresh install).
 */
export const hostMetricsSamples = sqliteTable('host_metrics_samples', {
  /** ISO 8601 UTC; one row per tick, so time itself is the key. */
  at: text('at').primaryKey(),
  /** Percent of the whole machine, 0-100. */
  cpuUsedPct: real('cpu_used_pct'),
  memTotalBytes: integer('mem_total_bytes').notNull(),
  /** /proc/meminfo MemAvailable semantics (counts reclaimable cache). */
  memAvailableBytes: integer('mem_available_bytes').notNull(),
  swapTotalBytes: integer('swap_total_bytes'),
  swapUsedBytes: integer('swap_used_bytes'),
  /** The filesystem holding DORMICE_DATA_DIR, df semantics. */
  diskTotalBytes: integer('disk_total_bytes'),
  diskUsedBytes: integer('disk_used_bytes'),
  diskAvailableBytes: integer('disk_available_bytes'),
});

export type HostMetricsSampleRow = typeof hostMetricsSamples.$inferSelect;

/**
 * The console's one human account — the gateway's table since 2026-09-14
 * (the console is served there; packages/gateway/src/db/schema.ts has the
 * living definition). Kept in the node's ledger, unread and unwritten,
 * until the one-time import of a single machine's old tables into the
 * gateway (cut 4) has run; it is dropped then, not before — a migration
 * that dropped it now would delete the operator's account ahead of the
 * step that moves it.
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

/**
 * Runtime settings — this node's copy of the fleet configuration (design
 * record #22, 2026-09-14): the gateway holds the settings and every node
 * keeps a copy, so a node whose gateway is away still knows what a new
 * sandbox gets and where its archives live. One row, fixed id — the
 * console_account singleton pattern — written whole by applyNodeConfig
 * (db/settings.ts) with every bundle the check-in brings, never edited
 * here: there is no verb on the node that changes a knob.
 *
 * config_version says which bundle the row is. NULL means the row is not
 * a copy at all: the daemon's own settings from before the move (seeded
 * from the env, edited from the console), kept for the one-time import
 * into the gateway (cut 4) and never read by the node again — the node
 * reports "no copy" and takes the gateway's bundle at its first check-in,
 * which overwrites every column.
 *
 * Typed columns, not a JSON blob: the schema IS the vocabulary, and a knob
 * that exists but is invisible to migrations would drift silently.
 */
export const runtimeSettings = sqliteTable('runtime_settings', {
  id: integer('id').primaryKey(),
  /** The bundle's version (shared nodeConfigBundleSchema); NULL = not a copy, see above. */
  configVersion: integer('config_version'),
  /** ISO 8601 UTC — when this copy was applied; the boot log's "how old is what I run". */
  configAppliedAt: text('config_applied_at'),
  sandboxCpus: real('sandbox_cpus').notNull(),
  sandboxMemoryGb: real('sandbox_memory_gb').notNull(),
  sandboxDiskGb: real('sandbox_disk_gb').notNull(),
  defaultFreezeAfterSeconds: integer('default_freeze_after_seconds').notNull(),
  /** NULL = new sandboxes default to never stopping. */
  defaultStopAfterSeconds: integer('default_stop_after_seconds'),
  /** NULL = never archive — forced when the daemon has no archiver. */
  defaultArchiveAfterSeconds: integer('default_archive_after_seconds'),
  /** This node's managed-swap target, GiB (swap.ts) — its own row at the gateway (updateNodeSettings); 0 = manage none. */
  swapGb: integer('swap_gb').notNull().default(0),
  /**
   * The S3 archive store and the sandbox domain. In a copy the two
   * decider columns (s3Endpoint, sandboxDomain) are two-state: a value,
   * or NULL = off. Rows from before the move used '' for off and NULL for
   * "never adjudicated"; a copy never writes '' and the readers never see
   * one — they refuse a row without config_version (db/settings.ts).
   *
   * s3SecretAccessKey is stored plaintext, like envdSigningSecret and
   * sessionSecret above: a credential the daemon must present verbatim to
   * S3 cannot be hashed. It never crosses the node's wire (shared
   * s3ArchiveViewSchema withholds both keys); it arrives with the bundle
   * over the gateway→node wire under the fleet token.
   */
  s3Endpoint: text('s3_endpoint'),
  s3Bucket: text('s3_bucket'),
  s3AccessKeyId: text('s3_access_key_id'),
  s3SecretAccessKey: text('s3_secret_access_key'),
  s3Region: text('s3_region'),
  s3ForcePathStyle: integer('s3_force_path_style', { mode: 'boolean' }),
  sandboxDomain: text('sandbox_domain'),
  /** Inbound-only alias domains, a JSON string array ('[]' = none). Nullable only for rows from before the move. */
  sandboxDomainAliases: text('sandbox_domain_aliases'),
  /**
   * The pids cgroup cap on every sandbox container. Never "off": a cap
   * always exists (shared/settings.ts enforces the floor). Nullable only
   * for rows from before the move.
   */
  pidsLimit: integer('pids_limit'),
  /**
   * The fleet's base image (shared settings.ts baseImage), in the copy
   * since the fourth cut (2026-09-15): what a template-less sandbox boots
   * from, pulled from the fleet registry when this host lacks it. NULL =
   * the fleet names none — this node then falls back to its own
   * DORMICE_BASE_IMAGE, the knob's old home (db/templates.ts
   * resolveBaseImage).
   */
  baseImage: text('base_image'),
  /** The fleet's image registry, host:port (shared settings.ts registryAddress); NULL = no registry, a missing image is a plain error. */
  registryAddress: text('registry_address'),
  /** The old single-machine row's last edit — the gateway's timestamp now; kept for the cut-4 import, never written by the node. */
  updatedAt: text('updated_at'),
});

export type RuntimeSettingsRow = typeof runtimeSettings.$inferSelect;

/**
 * API keys — the gateway's table since 2026-09-14: keys are minted and
 * judged at the fleet's one door (packages/gateway/src/db/schema.ts has
 * the living definition), and toward a node the gateway speaks the fleet
 * token alone. Kept in the node's ledger, unread and unwritten, until the
 * cut-4 import into the gateway has run — the same reasoning as
 * console_account above: a key an operator's automation still holds must
 * move, not vanish.
 */
export const apiKeys = sqliteTable(
  'api_keys',
  {
    /** UUID, never an autoincrement — ids must stay unique across machines. */
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** sha256 hex of the bare 64-hex key material. The key itself is never stored. */
    keyHash: text('key_hash').notNull().unique(),
    /** First 8 hex chars of the key, for display — 32 bits, no meaningful entropy. */
    prefix: text('prefix').notNull(),
    createdAt: text('created_at').notNull(),
    /** Null = never used. Written with 60s granularity, not per request. */
    lastUsedAt: text('last_used_at'),
    /**
     * Null = never expires. Always written through normalizeIso (exact
     * toISOString shape) so the liveness filter's string comparison against
     * "now" is chronologically sound — wire input has variable precision.
     */
    expiresAt: text('expires_at'),
    /**
     * Null = enabled. The reversible half of revocation: set/cleared by
     * updateApiKey, and the name stays held while disabled — only revoke
     * frees a name.
     */
    disabledAt: text('disabled_at'),
    /** Null = active. Set once by revokeApiKey; never cleared. */
    revokedAt: text('revoked_at'),
  },
  (table) => [
    uniqueIndex('api_keys_active_name_idx')
      .on(table.name)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
