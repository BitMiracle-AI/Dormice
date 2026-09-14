import type { S3Settings } from '@dormice/server/s3-store';
import {
  ARCHIVE_DEFAULT_SECONDS,
  DEFAULT_LIFECYCLE_POLICY,
  type RuntimeSettings,
  type UpdateSettingsRequest,
} from '@dormice/shared';
import { eq, sql } from 'drizzle-orm';
import { type Config, s3Seed } from '../config';
import type { Db, Writer } from './db';
import { type SettingsRow, settings } from './schema';

/** The console_account fixed-id pattern: "at most one row" as a schema fact. */
const SETTINGS_ROW_ID = 1;

/**
 * Seeds the settings row from the env at the gateway's first start —
 * insert-or-nothing, so every later start finds the row and leaves it
 * alone: the table is the one truth from then on, and a later env edit of
 * a seed is deliberately ignored (the daemon's discipline since 2026-07-19,
 * shared/settings.ts has the line). The archive default is adjudicated
 * here: an S3 seed present means new sandboxes archive after a week,
 * absent means never. Version 1 is the seed; every change counts up from
 * there, and the nodes compare against it at each check-in.
 */
export function ensureSettings(db: Db, config: Config): void {
  const s3 = s3Seed(config);
  db.insert(settings)
    .values({
      id: SETTINGS_ROW_ID,
      version: 1,
      sandboxCpus: config.DORMICE_SANDBOX_CPUS,
      sandboxMemoryGb: config.DORMICE_SANDBOX_MEMORY_GB,
      sandboxDiskGb: config.DORMICE_SANDBOX_DISK_GB,
      defaultFreezeAfterSeconds: DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
      defaultStopAfterSeconds: DEFAULT_LIFECYCLE_POLICY.stopAfterSeconds,
      defaultArchiveAfterSeconds: s3 ? ARCHIVE_DEFAULT_SECONDS : null,
      ...s3Columns(s3),
      sandboxDomain: config.DORMICE_SANDBOX_DOMAIN ?? null,
      sandboxDomainAliases: '[]',
      pidsLimit: config.DORMICE_SANDBOX_PIDS_LIMIT,
      updatedAt: null,
    })
    .onConflictDoNothing()
    .run();
}

/** The six S3 columns as one unit: a store, or all NULL = off. */
function s3Columns(s3: S3Settings | null) {
  return {
    s3Endpoint: s3?.endpoint ?? null,
    s3Bucket: s3?.bucket ?? null,
    s3AccessKeyId: s3?.accessKeyId ?? null,
    s3SecretAccessKey: s3?.secretAccessKey ?? null,
    s3Region: s3?.region ?? null,
    s3ForcePathStyle: s3?.forcePathStyle ?? null,
  };
}

function readRow(db: Db): SettingsRow {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.id, SETTINGS_ROW_ID))
    .get();
  if (!row) {
    throw new Error('settings row missing — ensureSettings must run at boot');
  }
  return row;
}

function toView(row: SettingsRow): RuntimeSettings {
  return {
    sandboxDefaults: {
      cpus: row.sandboxCpus,
      memoryGb: row.sandboxMemoryGb,
      diskGb: row.sandboxDiskGb,
    },
    defaultPolicy: {
      freezeAfterSeconds: row.defaultFreezeAfterSeconds,
      stopAfterSeconds: row.defaultStopAfterSeconds,
      archiveAfterSeconds: row.defaultArchiveAfterSeconds,
    },
    s3:
      row.s3Endpoint === null
        ? null
        : {
            endpoint: row.s3Endpoint,
            // biome-ignore-start lint/style/noNonNullAssertion: the six columns write as one unit (s3Columns)
            bucket: row.s3Bucket!,
            region: row.s3Region!,
            forcePathStyle: row.s3ForcePathStyle!,
            // biome-ignore-end lint/style/noNonNullAssertion: the six columns write as one unit (s3Columns)
          },
    sandboxDomain: row.sandboxDomain,
    // The one writer JSON.stringifies an array; a corrupt value should
    // throw right here, not read as "no aliases".
    sandboxDomainAliases: JSON.parse(row.sandboxDomainAliases) as string[],
    pidsLimit: row.pidsLimit,
    updatedAt: row.updatedAt,
  };
}

/** The knobs in force, read fresh at each use — a point read costs microseconds and makes a console edit apply to the very next request. */
export function readSettings(db: Db): RuntimeSettings {
  return toView(readRow(db));
}

/** The configuration version the nodes compare against: bumped by every write here, in db/templates.ts and by updateNodeSettings. */
export function readConfigVersion(db: Db): number {
  return readRow(db).version;
}

/**
 * The S3 store in force, keys included — for the probe that guards a
 * settings write and for the bundle a node pulls, never for the
 * observation wire (readSettings withholds both keys).
 */
export function readS3Settings(db: Db): S3Settings | null {
  const row = readRow(db);
  if (row.s3Endpoint === null) return null;
  return {
    endpoint: row.s3Endpoint,
    // biome-ignore-start lint/style/noNonNullAssertion: the six columns write as one unit (s3Columns)
    bucket: row.s3Bucket!,
    accessKeyId: row.s3AccessKeyId!,
    secretAccessKey: row.s3SecretAccessKey!,
    region: row.s3Region!,
    forcePathStyle: row.s3ForcePathStyle!,
    // biome-ignore-end lint/style/noNonNullAssertion: the six columns write as one unit (s3Columns)
  };
}

/**
 * Counts a configuration change the nodes must hear about. Callers that
 * change something outside this row (a template, a node's swap target)
 * run their own write and this bump inside one transaction, so a node can
 * never see the new version with the old content or the reverse.
 */
export function bumpConfigVersion(db: Writer): number {
  const row = db
    .update(settings)
    .set({ version: sql`${settings.version} + 1` })
    .where(eq(settings.id, SETTINGS_ROW_ID))
    .returning({ version: settings.version })
    .get();
  if (!row) {
    throw new Error('settings row missing — ensureSettings must run at boot');
  }
  return row.version;
}

/**
 * Applies an updateSettings patch: each provided group replaces that group
 * whole, absent groups keep their stored values (shared/settings.ts is the
 * arbiter of that contract), and the version counts up with the write.
 * Validation — the archive-without-store refusal, the alias rules, the
 * moving-store guard, the S3 probe — happened at the route; this is the
 * pure write.
 */
export function writeSettings(
  db: Db,
  patch: UpdateSettingsRequest,
  now: Date,
): RuntimeSettings {
  const row = db
    .update(settings)
    .set({
      ...(patch.sandboxDefaults !== undefined
        ? {
            sandboxCpus: patch.sandboxDefaults.cpus,
            sandboxMemoryGb: patch.sandboxDefaults.memoryGb,
            sandboxDiskGb: patch.sandboxDefaults.diskGb,
          }
        : {}),
      ...(patch.defaultPolicy !== undefined
        ? {
            defaultFreezeAfterSeconds: patch.defaultPolicy.freezeAfterSeconds,
            defaultStopAfterSeconds: patch.defaultPolicy.stopAfterSeconds,
            defaultArchiveAfterSeconds: patch.defaultPolicy.archiveAfterSeconds,
          }
        : {}),
      ...(patch.s3 !== undefined ? s3Columns(patch.s3) : {}),
      ...(patch.sandboxDomain !== undefined
        ? { sandboxDomain: patch.sandboxDomain }
        : {}),
      ...(patch.sandboxDomainAliases !== undefined
        ? { sandboxDomainAliases: JSON.stringify(patch.sandboxDomainAliases) }
        : {}),
      ...(patch.pidsLimit !== undefined ? { pidsLimit: patch.pidsLimit } : {}),
      version: sql`${settings.version} + 1`,
      updatedAt: now.toISOString(),
    })
    .where(eq(settings.id, SETTINGS_ROW_ID))
    .returning()
    .get();
  if (!row) {
    throw new Error('settings row missing — ensureSettings must run at boot');
  }
  return toView(row);
}
