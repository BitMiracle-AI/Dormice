import {
  DEFAULT_LIFECYCLE_POLICY,
  type RuntimeSettings,
  type UpdateSettingsRequest,
} from '@dormice/shared';
import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from './db';
import { type RuntimeSettingsRow, runtimeSettings } from './schema';

/** The console_account fixed-id pattern: "at most one row" as a schema fact. */
const SETTINGS_ROW_ID = 1;

/**
 * Get-or-seed, run at every boot before anything reads a knob. The seed is
 * the env variables (and, for the default policy, the shared zero-config
 * defaults plus the boot's archive adjudication) — so a daemon upgraded
 * onto this schema keeps behaving exactly as its env said, and a fresh
 * install needs no extra step. Idempotent: an existing row is the truth
 * and the env is not consulted again.
 *
 * archiveDefaultSeconds is the caller's adjudication of "is the archiver
 * configured" (null = no) — the same parameter resolvePolicy takes, decided
 * once per boot by the archiver's presence.
 */
export function ensureRuntimeSettings(
  db: Db,
  config: Config,
  archiveDefaultSeconds: number | null,
): void {
  db.insert(runtimeSettings)
    .values({
      id: SETTINGS_ROW_ID,
      maxSandboxes: config.DORMICE_MAX_SANDBOXES,
      sandboxCpus: config.DORMICE_SANDBOX_CPUS,
      sandboxMemoryGb: config.DORMICE_SANDBOX_MEMORY_GB,
      sandboxDiskGb: config.DORMICE_SANDBOX_DISK_GB,
      defaultFreezeAfterSeconds: DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
      defaultStopAfterSeconds: DEFAULT_LIFECYCLE_POLICY.stopAfterSeconds,
      defaultArchiveAfterSeconds: archiveDefaultSeconds,
      updatedAt: null,
    })
    .onConflictDoNothing()
    .run();
}

function toView(row: RuntimeSettingsRow): RuntimeSettings {
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
  return toView(row);
}

/**
 * Applies an updateSettings patch: each provided group replaces that group
 * whole, absent groups keep their stored values (shared/settings.ts is the
 * arbiter of that contract). Validation — including the archive-without-
 * archiver refusal — happened at the route; this is the pure write.
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
