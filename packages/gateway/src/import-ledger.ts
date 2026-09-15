import Database from 'better-sqlite3';
import type { Config } from './config';
import type { Db } from './db/db';
import { FLEET_SAMPLE_KEEP_DAYS } from './db/fleet-samples';
import {
  apiKeys,
  consoleAccount,
  fleetStateSamples,
  nodes,
  settings,
  templates,
} from './db/schema';
import { seedRow } from './db/settings';

/**
 * The one-time import of a single machine's ledger into the gateway's
 * tables (the fourth cut, 2026-09-15): what the daemon held as the
 * fleet's configuration before the authority moved to the gateway
 * (design record #22) — its settings row, its templates, its API keys,
 * its console account — and its fleet history, so the dashboard's
 * thirty-day curve does not break at the cut. install.sh runs it once,
 * before the gateway's first start: the gateway seeds its settings row
 * at that start and the node pulls the bundle at its first check-in, so
 * an import that came later would find the row taken and the node
 * already running on the env seeds — with the S3 store, the default
 * policy, the domain aliases and the templates the operator set over
 * months quietly gone (a restore from archive would fail, a template
 * sandbox would wake to "template not registered"). Refused, with exit
 * 2, when the gateway's settings row exists: this is for a first start,
 * and a backup file can be imported into a fresh gateway database the
 * same way.
 *
 * The node's ledger is read through a read-only handle with plain SQL
 * naming each column — not the daemon's drizzle schema, whose shape is
 * this build's, where the ledger on the machine is whatever build the
 * daemon last ran: a column the ledger lacks reads as NULL (the Beijing
 * node at the cut sits before the config-copy migration), an extra
 * column it carries is never asked for (the test machine's api_keys has
 * a `delegate` left by an abandoned branch). Values are never printed:
 * the settings row holds the S3 secret and the keys table the hashes;
 * the report is counts.
 */

export interface ImportCounts {
  settings: number;
  nodes: number;
  templates: number;
  apiKeys: number;
  consoleAccount: number;
  fleetStateSamples: number;
}

export type ImportOutcome =
  | { code: 0; counts: ImportCounts }
  /** The gateway's settings row exists: nothing written (exit 2 at the CLI). */
  | { code: 2; message: string };

export interface ImportInput {
  /** The node's ledger (DORMICE_DB_PATH), read-only. */
  nodeDbPath: string;
  /** The node's env file, parsed (parseEnvFile): its identity — node id, endpoint, port, base image. */
  nodeEnv: Record<string, string>;
  now?: Date;
}

/**
 * `KEY=VALUE` lines, the systemd EnvironmentFile dialect install.sh
 * writes: blank lines and `#` comments skipped, one pair of surrounding
 * quotes stripped. Nothing more — the file is ours.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/** One row of the node's `runtime_settings`, the columns the import reads — NULL where the ledger lacks the column. */
interface NodeSettingsRow {
  sandbox_cpus: number;
  sandbox_memory_gb: number;
  sandbox_disk_gb: number;
  default_freeze_after_seconds: number;
  default_stop_after_seconds: number | null;
  default_archive_after_seconds: number | null;
  swap_gb: number | null;
  s3_endpoint: string | null;
  s3_bucket: string | null;
  s3_access_key_id: string | null;
  s3_secret_access_key: string | null;
  s3_region: string | null;
  s3_force_path_style: number | null;
  sandbox_domain: string | null;
  sandbox_domain_aliases: string | null;
  pids_limit: number | null;
  base_image: string | null;
  registry_address: string | null;
  updated_at: string | null;
}

const NODE_SETTINGS_COLUMNS: Array<keyof NodeSettingsRow> = [
  'sandbox_cpus',
  'sandbox_memory_gb',
  'sandbox_disk_gb',
  'default_freeze_after_seconds',
  'default_stop_after_seconds',
  'default_archive_after_seconds',
  'swap_gb',
  's3_endpoint',
  's3_bucket',
  's3_access_key_id',
  's3_secret_access_key',
  's3_region',
  's3_force_path_style',
  'sandbox_domain',
  'sandbox_domain_aliases',
  'pids_limit',
  'base_image',
  'registry_address',
  'updated_at',
];

const API_KEY_COLUMNS = [
  'id',
  'name',
  'key_hash',
  'prefix',
  'created_at',
  'last_used_at',
  'expires_at',
  'disabled_at',
  'revoked_at',
] as const;

const CONSOLE_ACCOUNT_COLUMNS = [
  'id',
  'username',
  'password_hash',
  'session_secret',
  'created_at',
  'updated_at',
] as const;

const TEMPLATE_COLUMNS = ['name', 'image', 'created_at', 'updated_at'] as const;

const SAMPLE_COLUMNS = [
  'at',
  'active',
  'frozen',
  'stopped',
  'archived',
  'restoring',
  'total',
] as const;

/** SQLite's bound-parameter ceiling is generous (32766), but a 79,603-row history is inserted in slices all the same. */
const INSERT_CHUNK = 500;

export function importNodeLedger(
  db: Db,
  config: Config,
  input: ImportInput,
): ImportOutcome {
  const now = input.now ?? new Date();
  const existing = db.select({ id: settings.id }).from(settings).get();
  if (existing !== undefined) {
    return {
      code: 2,
      message: `the gateway database at ${config.DORMICE_GATEWAY_DB_PATH} already holds a settings row — the import is for a gateway's first start; nothing was written`,
    };
  }
  const source = new Database(input.nodeDbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const read = new LedgerReader(source);
    const nodeSettings = read.settingsRow();
    if (nodeSettings === undefined) {
      throw new Error(
        `${input.nodeDbPath} has no runtime_settings row — not a daemon's ledger, or one that never started`,
      );
    }
    const seed = seedRow(config);
    const s3On = nonEmpty(nodeSettings.s3_endpoint) !== null;
    const row: typeof settings.$inferInsert = {
      ...seed,
      sandboxCpus: nodeSettings.sandbox_cpus,
      sandboxMemoryGb: nodeSettings.sandbox_memory_gb,
      sandboxDiskGb: nodeSettings.sandbox_disk_gb,
      defaultFreezeAfterSeconds: nodeSettings.default_freeze_after_seconds,
      defaultStopAfterSeconds: nodeSettings.default_stop_after_seconds,
      // A default that archives with no store would be the standing lie
      // the gateway's updateSettings refuses; the node's own seeding
      // forced null here too.
      defaultArchiveAfterSeconds: s3On
        ? nodeSettings.default_archive_after_seconds
        : null,
      // The six as one unit: on, all six from the node; off ('' or NULL —
      // the pre-move row's two spellings of off), all six NULL.
      s3Endpoint: s3On ? nodeSettings.s3_endpoint : null,
      s3Bucket: s3On ? nodeSettings.s3_bucket : null,
      s3AccessKeyId: s3On ? nodeSettings.s3_access_key_id : null,
      s3SecretAccessKey: s3On ? nodeSettings.s3_secret_access_key : null,
      s3Region: s3On ? nodeSettings.s3_region : null,
      s3ForcePathStyle: s3On
        ? nodeSettings.s3_force_path_style === null
          ? null
          : nodeSettings.s3_force_path_style !== 0
        : null,
      sandboxDomain: nonEmpty(nodeSettings.sandbox_domain),
      sandboxDomainAliases: nodeSettings.sandbox_domain_aliases ?? '[]',
      pidsLimit: nodeSettings.pids_limit ?? seed.pidsLimit,
      // The base image's homes, newest first: the node's copy (a node
      // already on the fourth cut), the node's env (its old home), the
      // gateway's seed.
      baseImage:
        nodeSettings.base_image ??
        nonEmpty(input.nodeEnv.DORMICE_BASE_IMAGE ?? null) ??
        seed.baseImage,
      registryAddress: seed.registryAddress ?? nodeSettings.registry_address,
      // The operator's last edit, carried: this row is not the seed.
      updatedAt: nodeSettings.updated_at,
    };
    const nodeId = nonEmpty(input.nodeEnv.DORMICE_NODE_ID ?? null) ?? 'node-1';
    const endpoint =
      nonEmpty(input.nodeEnv.DORMICE_NODE_ENDPOINT ?? null) ??
      `http://127.0.0.1:${nonEmpty(input.nodeEnv.DORMICE_PORT ?? null) ?? '3676'}`;
    const cutoff = new Date(
      now.getTime() - FLEET_SAMPLE_KEEP_DAYS * 86_400_000,
    ).toISOString();
    const templateRows = read.rows('templates', TEMPLATE_COLUMNS);
    const keyRows = read.rows('api_keys', API_KEY_COLUMNS);
    const accountRows = read.rows('console_account', CONSOLE_ACCOUNT_COLUMNS);
    const sampleRows = read.rows(
      'fleet_snapshots',
      SAMPLE_COLUMNS,
      'WHERE at >= ?',
      [cutoff],
    );
    const counts: ImportCounts = {
      settings: 1,
      nodes: 1,
      templates: templateRows.length,
      apiKeys: keyRows.length,
      consoleAccount: accountRows.length,
      fleetStateSamples: sampleRows.length,
    };
    db.transaction((tx) => {
      tx.insert(settings).values(row).run();
      // The node's row, so its swap target survives the cut (the daemon
      // reconciles its managed swap from the bundle's node row; a fleet
      // that forgot the target would stop growing swap after the next
      // reboot). Never checked in yet: fleet.ts loads it as such, and
      // the node's first check-in fills the rest.
      tx.insert(nodes)
        .values({
          id: nodeId,
          endpoint: endpoint.replace(/\/+$/, ''),
          addedAt: now.toISOString(),
          swapGb: nodeSettings.swap_gb ?? 0,
        })
        .run();
      for (const chunk of chunks(templateRows)) {
        tx.insert(templates)
          .values(
            chunk.map((r) => ({
              name: r.name as string,
              image: r.image as string,
              createdAt: r.created_at as string,
              updatedAt: r.updated_at as string,
            })),
          )
          .run();
      }
      for (const chunk of chunks(keyRows)) {
        tx.insert(apiKeys)
          .values(
            chunk.map((r) => ({
              id: r.id as string,
              name: r.name as string,
              keyHash: r.key_hash as string,
              prefix: r.prefix as string,
              createdAt: r.created_at as string,
              lastUsedAt: r.last_used_at as string | null,
              expiresAt: r.expires_at as string | null,
              disabledAt: r.disabled_at as string | null,
              revokedAt: r.revoked_at as string | null,
            })),
          )
          .run();
      }
      for (const chunk of chunks(accountRows)) {
        tx.insert(consoleAccount)
          .values(
            chunk.map((r) => ({
              id: r.id as number,
              username: r.username as string,
              passwordHash: r.password_hash as string,
              sessionSecret: r.session_secret as string,
              createdAt: r.created_at as string,
              updatedAt: r.updated_at as string,
            })),
          )
          .run();
      }
      for (const chunk of chunks(sampleRows)) {
        tx.insert(fleetStateSamples)
          .values(
            chunk.map((r) => ({
              at: r.at as string,
              active: r.active as number,
              frozen: r.frozen as number,
              stopped: r.stopped as number,
              archived: r.archived as number,
              restoring: r.restoring as number,
              total: r.total as number,
            })),
          )
          .run();
      }
    });
    return { code: 0, counts };
  } finally {
    source.close();
  }
}

/** '' and NULL are both "unset" in a pre-move row (schema.ts on the node has the story); the gateway knows NULL alone. */
function nonEmpty(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}

function* chunks<T>(rows: T[]): Generator<T[]> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    yield rows.slice(i, i + INSERT_CHUNK);
  }
}

/**
 * Plain SQL over the node's ledger, asking only for columns the table
 * has: `PRAGMA table_info` first, then a SELECT that names the present
 * ones and reads the absent as NULL — the ledger's shape is the build
 * the daemon last ran, not this one's.
 */
class LedgerReader {
  constructor(private readonly db: Database.Database) {}

  private columnsOf(table: string): Set<string> {
    const info = this.db
      .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
      .all() as Array<{ name: string }>;
    return new Set(info.map((c) => c.name));
  }

  private hasTable(table: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table) !== undefined
    );
  }

  settingsRow(): NodeSettingsRow | undefined {
    if (!this.hasTable('runtime_settings')) return undefined;
    const present = this.columnsOf('runtime_settings');
    const select = NODE_SETTINGS_COLUMNS.map((c) =>
      present.has(c) ? quoteIdent(c) : `NULL AS ${quoteIdent(c)}`,
    ).join(', ');
    return this.db
      .prepare(`SELECT ${select} FROM runtime_settings WHERE id = 1`)
      .get() as NodeSettingsRow | undefined;
  }

  /** Every row of a table, the named columns only (absent columns read NULL; a table the ledger lacks reads empty). */
  rows(
    table: string,
    columns: readonly string[],
    where = '',
    params: unknown[] = [],
  ): Array<Record<string, unknown>> {
    if (!this.hasTable(table)) return [];
    const present = this.columnsOf(table);
    const select = columns
      .map((c) => (present.has(c) ? quoteIdent(c) : `NULL AS ${quoteIdent(c)}`))
      .join(', ');
    return this.db
      .prepare(`SELECT ${select} FROM ${quoteIdent(table)} ${where}`)
      .all(...params) as Array<Record<string, unknown>>;
  }
}

/** Identifiers here are this module's own constants, never input; quoted all the same. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
