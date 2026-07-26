import {
  DEFAULT_LIFECYCLE_POLICY,
  type RuntimeSettings,
  type UpdateSettingsRequest,
} from '@dormice/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { S3Settings } from '../archive/s3-store';
import { type Config, s3Settings } from '../config';
import { ARCHIVE_DEFAULT_SECONDS } from '../policy';
import type { Db } from './db';
import { type RuntimeSettingsRow, runtimeSettings } from './schema';

/** The console_account fixed-id pattern: "at most one row" as a schema fact. */
const SETTINGS_ROW_ID = 1;

/**
 * The per-knob three-state (see schema.ts): NULL = never adjudicated, '' =
 * explicitly off. '' is a storage sentinel and never leaves this file.
 */
const OFF = '';

/**
 * Get-or-seed, run at every boot before anything reads a knob, in two
 * idempotent steps:
 *
 * 1. Insert-or-nothing — a fresh install seeds every column from the env
 *    variables (and the shared zero-config defaults). The archive default
 *    is adjudicated right here: an S3 seed present means new sandboxes
 *    archive after a week, absent means never — the same semantics the
 *    boot-time archiver adjudication used to produce.
 * 2. Adopt-if-virgin — a daemon upgraded onto a schema with new columns
 *    finds them NULL on its existing row; each such column gets its one
 *    env consultation now (the knob's ledger life begins at its first
 *    value). The adopt step never touches defaultArchiveAfterSeconds: an
 *    existing row's default policy is the operator's property, and one
 *    group's seed must not rewrite another group (the update doctrine).
 *
 * After the first boot both steps match zero rows. "The env is ignored
 * once the ledger speaks" is per knob: a console clear writes '' (not
 * NULL), so a restart never resurrects the env value.
 */
export function ensureRuntimeSettings(db: Db, config: Config): void {
  const s3Seed = s3Settings(config);
  db.insert(runtimeSettings)
    .values({
      id: SETTINGS_ROW_ID,
      maxSandboxes: config.DORMICE_MAX_SANDBOXES,
      sandboxCpus: config.DORMICE_SANDBOX_CPUS,
      sandboxMemoryGb: config.DORMICE_SANDBOX_MEMORY_GB,
      sandboxDiskGb: config.DORMICE_SANDBOX_DISK_GB,
      defaultFreezeAfterSeconds: DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
      defaultStopAfterSeconds: DEFAULT_LIFECYCLE_POLICY.stopAfterSeconds,
      defaultArchiveAfterSeconds: s3Seed ? ARCHIVE_DEFAULT_SECONDS : null,
      // No env seed: managed swap is born from the console, not the env —
      // install.sh's base swapfile already covers "a host needs swap".
      swapGb: 0,
      ...s3Columns(s3Seed),
      sandboxDomain: config.DORMICE_SANDBOX_DOMAIN ?? OFF,
      updatedAt: null,
    })
    .onConflictDoNothing()
    .run();
  db.update(runtimeSettings)
    .set(s3Columns(s3Seed))
    .where(
      and(
        eq(runtimeSettings.id, SETTINGS_ROW_ID),
        isNull(runtimeSettings.s3Endpoint),
      ),
    )
    .run();
  db.update(runtimeSettings)
    .set({ sandboxDomain: config.DORMICE_SANDBOX_DOMAIN ?? OFF })
    .where(
      and(
        eq(runtimeSettings.id, SETTINGS_ROW_ID),
        isNull(runtimeSettings.sandboxDomain),
      ),
    )
    .run();
}

/** The six S3 columns as one unit: a store, or the '' decider + NULL rest. */
function s3Columns(s3: S3Settings | null) {
  return s3
    ? {
        s3Endpoint: s3.endpoint,
        s3Bucket: s3.bucket,
        s3AccessKeyId: s3.accessKeyId,
        s3SecretAccessKey: s3.secretAccessKey,
        s3Region: s3.region,
        s3ForcePathStyle: s3.forcePathStyle,
      }
    : {
        s3Endpoint: OFF,
        s3Bucket: null,
        s3AccessKeyId: null,
        s3SecretAccessKey: null,
        s3Region: null,
        s3ForcePathStyle: null,
      };
}

function virginError(column: string): Error {
  return new Error(
    `runtime settings column ${column} was never adjudicated — ensureRuntimeSettings must run at boot`,
  );
}

function toView(row: RuntimeSettingsRow): RuntimeSettings {
  if (row.s3Endpoint === null) throw virginError('s3_endpoint');
  if (row.sandboxDomain === null) throw virginError('sandbox_domain');
  return {
    maxSandboxes: row.maxSandboxes,
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
    swapGb: row.swapGb,
    s3:
      row.s3Endpoint === OFF
        ? null
        : {
            endpoint: row.s3Endpoint,
            // biome-ignore lint/style/noNonNullAssertion: the six columns write as one unit (s3Columns)
            bucket: row.s3Bucket!,
            region: row.s3Region!,
            forcePathStyle: row.s3ForcePathStyle!,
          },
    sandboxDomain: row.sandboxDomain === OFF ? null : row.sandboxDomain,
    updatedAt: row.updatedAt,
  };
}

/**
 * The knobs in force, read fresh at each use site — a better-sqlite3 point
 * read costs microseconds, and reading live is what makes a console edit
 * apply to the very next acquire without a restart. Throws when the row is
 * missing: that means ensureRuntimeSettings never ran, a wiring bug worth a
 * loud death, not a silent fallback to env.
 */
export function readRuntimeSettings(db: Db): RuntimeSettings {
  return toView(readRow(db));
}

/**
 * The S3 store in force, keys included — server-only, for building the
 * actual S3 client (archive/ledger-store.ts) and nothing else. The wire
 * shape (readRuntimeSettings().s3) withholds both keys; this one exists
 * because the daemon must present them verbatim to S3.
 */
export function readS3Settings(db: Db): S3Settings | null {
  const row = readRow(db);
  if (row.s3Endpoint === null) throw virginError('s3_endpoint');
  if (row.s3Endpoint === OFF) return null;
  return {
    endpoint: row.s3Endpoint,
    // biome-ignore lint/style/noNonNullAssertion: the six columns write as one unit (s3Columns)
    bucket: row.s3Bucket!,
    accessKeyId: row.s3AccessKeyId!,
    secretAccessKey: row.s3SecretAccessKey!,
    region: row.s3Region!,
    forcePathStyle: row.s3ForcePathStyle!,
  };
}

/** The one adjudication of "is archiving available", read live. */
export function archiveEnabled(db: Db): boolean {
  return readS3Settings(db) !== null;
}

function readRow(db: Db): RuntimeSettingsRow {
  const row = db
    .select()
    .from(runtimeSettings)
    .where(eq(runtimeSettings.id, SETTINGS_ROW_ID))
    .get();
  if (!row) {
    throw new Error(
      'runtime settings row missing — ensureRuntimeSettings must run at boot',
    );
  }
  return row;
}

/**
 * Applies an updateSettings patch: each provided group replaces that group
 * whole, absent groups keep their stored values (shared/settings.ts is the
 * arbiter of that contract). Validation — the archive-without-archiver
 * refusal, the moving-store guard, the S3 probe — happened at the route;
 * this is the pure write.
 */
export function writeRuntimeSettings(
  db: Db,
  patch: UpdateSettingsRequest,
  now: Date,
): RuntimeSettings {
  const row = db
    .update(runtimeSettings)
    .set({
      ...(patch.maxSandboxes !== undefined
        ? { maxSandboxes: patch.maxSandboxes }
        : {}),
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
      ...(patch.swapGb !== undefined ? { swapGb: patch.swapGb } : {}),
      ...(patch.s3 !== undefined ? s3Columns(patch.s3) : {}),
      ...(patch.sandboxDomain !== undefined
        ? { sandboxDomain: patch.sandboxDomain ?? OFF }
        : {}),
      updatedAt: now.toISOString(),
    })
    .where(eq(runtimeSettings.id, SETTINGS_ROW_ID))
    .returning()
    .get();
  if (!row) {
    throw new Error(
      'runtime settings row missing — ensureRuntimeSettings must run at boot',
    );
  }
  return toView(row);
}
