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
 * The gateway's tables are "how the fleet is configured and who may
 * enter" — never a sandbox's state, which lives in the ledger of the node
 * that runs it and is asked for when needed (find.ts). Five tables of
 * configuration: the nodes that have ever checked in, the fleet-wide
 * settings row, the templates, the API keys and the console account. The
 * last four moved here from the daemon with the configuration authority
 * (design record #22, 2026-09-13): one authority, one edit, every node
 * pulls it at its next check-in and keeps a copy in its own ledger. And
 * one table of observation, fleet_state_samples: the one figure no single
 * node can compute (design record #26).
 */

/**
 * Every node that has ever checked in (routes/nodes.ts): its id, the
 * address the gateway forwards to, when it first appeared, the one
 * per-node setting — how much swap its daemon manages on its own disk —
 * and, since the fourth cut, what it last reported: when and at what
 * interval, running which configuration version and build, and its
 * reading (two JSON columns in the wire schemas' shapes). Written by the
 * nodes themselves at every check-in — there is no registration verb and
 * no nodes file, so "which nodes exist" has exactly one home — and
 * deleted only by an operator's removeNode. Persistent, not memory, for
 * two reasons: a node that is down must still be known after a gateway
 * restart, or a name that lives only there would be placed anew elsewhere
 * and come back as a conflict when the node returns; and a restarted
 * gateway must judge its nodes by their last check-in, not by its own age
 * — with the check-in in memory only (the third cut), "silent since the
 * gateway started" was true of every node for up to an interval after
 * every restart, and four rules carried a thirty-second grace for it.
 */
export const nodes = sqliteTable('nodes', {
  /** DORMICE_NODE_ID as the node states it — the `nodeId` in every sandbox answer. */
  id: text('id').primaryKey(),
  /** Where the gateway forwards to; updated when a check-in states a new one. */
  endpoint: text('endpoint').notNull(),
  /** ISO 8601 UTC — the first check-in. */
  addedAt: text('added_at').notNull(),
  /**
   * Managed swap the node's daemon keeps on its data disk, GiB, on top of
   * the host's own — the one setting that is a machine's, not the fleet's
   * (a 29 GB test box and a 243 GB production box want different numbers).
   * Set by updateNodeSettings; the node applies it at its next check-in.
   * 0 = manage none, the only value that fits every host at birth.
   */
  swapGb: integer('swap_gb').notNull().default(0),
  /** ISO 8601 UTC — the last check-in taken; null for a row that has never checked in (the import pre-creates one). */
  lastCheckInAt: text('last_check_in_at'),
  /** The interval the node stated at that check-in — the yardstick for "two missed". */
  intervalSeconds: integer('interval_seconds'),
  /** The configuration version the node said it runs; null = no copy yet, or never said. */
  configVersion: integer('config_version'),
  /** JSON, shared buildInfoSchema; null = a dist built outside a checkout, or never checked in. */
  build: text('build'),
  /** JSON, shared nodeReadingSchema; null until the first check-in. */
  reading: text('reading'),
  /** JSON `{available, reason}` — whether the node can upgrade itself, its own word at its last check-in; null = it did not say (a build before the fourth cut) or never checked in. */
  selfUpgrade: text('self_upgrade'),
  /**
   * ISO 8601 UTC — when the fleet upgrade last told this node to upgrade
   * itself (rolling.ts); null = never, or the tell was fulfilled (the node
   * came back on another build). On the row so a gateway restart
   * mid-roll neither forgets a node it told nor tells it twice.
   */
  upgradeToldAt: text('upgrade_told_at'),
  /**
   * The commit the node ran when it was told — what "fulfilled" is judged
   * against: a node reporting any other commit did what it was told,
   * whether or not that commit is the gateway's by now (the gateway may
   * have upgraded again meanwhile). Null beside a tell only on a row
   * written before this column existed; fleet.ts reads such a tell as
   * none.
   */
  upgradeToldBuild: text('upgrade_told_build'),
});

export type NodeRow = typeof nodes.$inferSelect;

/**
 * The fleet-wide settings: one row, fixed id — the operator knobs whose
 * change is an operations decision, never a machine's identity (shared
 * settings.ts draws the line). `version` counts every configuration
 * change the nodes must hear about — this row, a node's row, the
 * templates — and rides the check-in wire: a node reports the version it
 * applied, the gateway answers the current one and, when they differ, the
 * whole bundle. Two states per optional group (NULL = off), no sentinel:
 * the row is born whole from the env seeds at the gateway's first start,
 * never adopted column by column as the daemon's once was.
 *
 * s3SecretAccessKey is stored plaintext, like the daemon's own secrets: a
 * credential presented verbatim to S3 cannot be hashed. It leaves this
 * table on exactly one path — the check-in bundle to a node, on the
 * intranet, under the fleet token — and never on the observation wire.
 */
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  version: integer('version').notNull(),
  sandboxCpus: real('sandbox_cpus').notNull(),
  sandboxMemoryGb: real('sandbox_memory_gb').notNull(),
  sandboxDiskGb: real('sandbox_disk_gb').notNull(),
  defaultFreezeAfterSeconds: integer('default_freeze_after_seconds').notNull(),
  /** NULL = new sandboxes default to never stopping. */
  defaultStopAfterSeconds: integer('default_stop_after_seconds'),
  /** NULL = never archive — forced while the fleet has no store. */
  defaultArchiveAfterSeconds: integer('default_archive_after_seconds'),
  /** The S3 archive store; all six NULL = archiving is off. */
  s3Endpoint: text('s3_endpoint'),
  s3Bucket: text('s3_bucket'),
  s3AccessKeyId: text('s3_access_key_id'),
  s3SecretAccessKey: text('s3_secret_access_key'),
  s3Region: text('s3_region'),
  s3ForcePathStyle: integer('s3_force_path_style', { mode: 'boolean' }),
  /** The canonical sandbox wildcard domain; NULL = the port proxy and domain fields are off. */
  sandboxDomain: text('sandbox_domain'),
  /** Inbound-only alias domains, a JSON string array; '[]' = none. */
  sandboxDomainAliases: text('sandbox_domain_aliases').notNull(),
  /** The pids cgroup cap on every sandbox container, fleet-wide. */
  pidsLimit: integer('pids_limit').notNull(),
  /**
   * The fleet's base image, a bare reference (shared settings.ts
   * baseImage); NULL = none set. Born after the row (the fourth cut), so
   * a table seeded before it holds NULL here until the env seed fills it
   * once or the console writes it (db/settings.ts ensureSettings).
   */
  baseImage: text('base_image'),
  /** The fleet's image registry, host:port (shared settings.ts registryAddress); NULL = no registry. Born with baseImage, filled the same way. */
  registryAddress: text('registry_address'),
  /** Null until the first updateSettings: "still exactly the seed" is information. */
  updatedAt: text('updated_at'),
});

export type SettingsRow = typeof settings.$inferSelect;

/**
 * Templates: a name for an image, fleet-wide. Registered here, carried to
 * every node in the bundle (a cold wake of a template sandbox resolves
 * name → image on the node, with or without a gateway present). Removal
 * asks every node whether a sandbox still uses the name (routes/templates.ts).
 */
export const templates = sqliteTable('templates', {
  name: text('name').primaryKey(),
  image: text('image').notNull(),
  createdAt: text('created_at').notNull(),
  /** Bumped only when the image actually changes — see db/templates.ts. */
  updatedAt: text('updated_at').notNull(),
});

export type TemplateRow = typeof templates.$inferSelect;

/**
 * Gateway-minted API keys: the credentials callers present at the fleet's
 * one door, peers of DORMICE_API_TOKEN over the sandbox verbs. They exist
 * so a client's secret can rotate without an env edit and a restart on
 * every machine of the fleet (design record #20): mint a new key, move the
 * client over, revoke the old one, a minute's work and no downtime. The
 * env token itself never lives here — it stays the bootstrap/recovery
 * credential, checked from config, and the one credential nodes accept.
 *
 * keyHash is sha256 of the key material, not scrypt: a key is 256 random
 * bits, not a human password, so offline brute force is moot and a slow
 * KDF would only tax every authenticated request. Verification is an
 * indexed exact-match lookup on the hash.
 *
 * Revocation is soft (revokedAt) — the row stays as rotation history and
 * keeps lastUsedAt readable after the credential dies. "At most one ACTIVE
 * key per name" is a schema fact via the partial unique index below; a
 * revoked name is free for reuse.
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

/**
 * The web console's single human account, one row with a fixed id: the
 * fleet has one console (design record #24) and the console has one
 * operator. Setup with the env token overwrites the row — creation,
 * password change and forgot-password are one verb (routes/console.ts).
 */
export const consoleAccount = sqliteTable('console_account', {
  id: integer('id').primaryKey(),
  username: text('username').notNull(),
  /** Self-describing scrypt string: scrypt$N$r$p$<salt b64>$<hash b64>. */
  passwordHash: text('password_hash').notNull(),
  /** The HMAC key of every session cookie; a new one voids every session. */
  sessionSecret: text('session_secret').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type ConsoleAccountRow = typeof consoleAccount.$inferSelect;

/**
 * The fleet's state counts over time — how many sandboxes sat in each
 * state across every node — one row per tick of the gateway's sampler
 * (main.ts, db/fleet-samples.ts; DORMICE_GATEWAY_SAMPLE_INTERVAL_SECONDS,
 * 30 by default): the sum of every node's last census at that moment,
 * the data behind the console's concurrency curve and its peak. The one
 * figure no single node can compute (design record #26) — each node's
 * own machine history stays on that node (host_metrics_samples), and the
 * nodes write no fleet history of their own since the third cut. Kept 30
 * days, the dashboard's widest range; pruned with every write.
 *
 * Five explicit state columns instead of a JSON blob, as on the node's
 * old table: the window peak is max(active) in one SQL aggregate, and the
 * stacked chart needs each state addressable. `total` is stored
 * redundantly so readers never re-derive it. `at` is indexed, not unique:
 * the fourth cut's import lays a single node's old rows beside these.
 */
export const fleetStateSamples = sqliteTable(
  'fleet_state_samples',
  {
    /** ISO 8601 UTC — the instant of the sampler tick that summed the readings. */
    at: text('at').notNull(),
    active: integer('active').notNull(),
    frozen: integer('frozen').notNull(),
    stopped: integer('stopped').notNull(),
    archived: integer('archived').notNull(),
    restoring: integer('restoring').notNull(),
    total: integer('total').notNull(),
  },
  (table) => [index('fleet_state_samples_at_idx').on(table.at)],
);

export type FleetStateSampleRow = typeof fleetStateSamples.$inferSelect;
