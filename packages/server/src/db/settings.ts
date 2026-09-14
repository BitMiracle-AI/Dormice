import type { NodeConfigBundle, RuntimeSettings } from '@dormice/shared';
import { eq } from 'drizzle-orm';
import type { S3Settings } from '../archive/s3-store';
import type { Db } from './db';
import { type RuntimeSettingsRow, runtimeSettings, templates } from './schema';

/** The console_account fixed-id pattern: "at most one row" as a schema fact. */
const SETTINGS_ROW_ID = 1;

/**
 * The fleet settings as this node runs them: the wire's read shape (keys
 * withheld — readS3Settings has them, for the one consumer that presents
 * them to S3) minus the gateway's edit timestamp, which is the gateway's
 * to answer.
 */
export type NodeSettings = Omit<RuntimeSettings, 'updatedAt'>;

/**
 * Thrown by every reader while the node holds no configuration copy. A
 * wiring guard, not a runtime state: main.ts blocks before listen until
 * the first bundle has been applied, so no request can observe it —
 * reaching it means something read a knob before boot finished.
 */
export class NoConfigError extends Error {
  constructor() {
    super(
      'this node holds no configuration copy yet — it is applied at the first check-in with the gateway, before the daemon listens',
    );
    this.name = 'NoConfigError';
  }
}

/**
 * The version of the copy this node runs, or null when it holds none: no
 * row, or a row from before the configuration moved to the gateway
 * (schema.ts runtimeSettings has the story). The check-in reports it, and
 * the gateway answers the whole bundle whenever it differs from its own.
 */
export function readConfigVersion(db: Db): number | null {
  return (
    db
      .select({ version: runtimeSettings.configVersion })
      .from(runtimeSettings)
      .where(eq(runtimeSettings.id, SETTINGS_ROW_ID))
      .get()?.version ?? null
  );
}

/** When the copy this node runs was applied (ISO 8601), for the boot log. */
export function readConfigAppliedAt(db: Db): string | null {
  return readRow(db).configAppliedAt;
}

/**
 * Writes a bundle whole: the settings row (every column — an old
 * single-machine row is overwritten, not merged) and the templates table
 * (delete-all, insert-all) in one transaction, so no reader ever sees the
 * new version with the old content, or a settings row from one version
 * beside templates from another. The pure write; the two knobs with a
 * reality on the host that a write does not move (the pids cap on running
 * shells, the managed swap) are node-config.ts's to reconcile afterwards.
 */
export function applyNodeConfig(
  db: Db,
  bundle: NodeConfigBundle,
  now = new Date(),
): void {
  const { settings, node } = bundle;
  const row = {
    id: SETTINGS_ROW_ID,
    configVersion: bundle.version,
    configAppliedAt: now.toISOString(),
    sandboxCpus: settings.sandboxDefaults.cpus,
    sandboxMemoryGb: settings.sandboxDefaults.memoryGb,
    sandboxDiskGb: settings.sandboxDefaults.diskGb,
    defaultFreezeAfterSeconds: settings.defaultPolicy.freezeAfterSeconds,
    defaultStopAfterSeconds: settings.defaultPolicy.stopAfterSeconds,
    defaultArchiveAfterSeconds: settings.defaultPolicy.archiveAfterSeconds,
    swapGb: node.swapGb,
    s3Endpoint: settings.s3?.endpoint ?? null,
    s3Bucket: settings.s3?.bucket ?? null,
    s3AccessKeyId: settings.s3?.accessKeyId ?? null,
    s3SecretAccessKey: settings.s3?.secretAccessKey ?? null,
    s3Region: settings.s3?.region ?? null,
    s3ForcePathStyle: settings.s3?.forcePathStyle ?? null,
    sandboxDomain: settings.sandboxDomain,
    sandboxDomainAliases: JSON.stringify(settings.sandboxDomainAliases),
    pidsLimit: settings.pidsLimit,
  };
  const { id: _id, ...set } = row;
  db.transaction((tx) => {
    tx.insert(runtimeSettings)
      .values(row)
      .onConflictDoUpdate({ target: runtimeSettings.id, set })
      .run();
    tx.delete(templates).run();
    if (bundle.templates.length > 0) {
      tx.insert(templates).values(bundle.templates).run();
    }
  });
}

/**
 * The copy read back whole, keys included — what the node runs, in the
 * bundle's own shape. For the boot log and for tests that edit a copy in
 * place; the request handlers read the narrower views below.
 */
export function readNodeConfig(db: Db): NodeConfigBundle {
  const row = readRow(db);
  const view = toView(row);
  return {
    version: row.configVersion as number,
    settings: {
      sandboxDefaults: view.sandboxDefaults,
      defaultPolicy: view.defaultPolicy,
      s3: readS3Settings(db),
      sandboxDomain: view.sandboxDomain,
      sandboxDomainAliases: view.sandboxDomainAliases,
      pidsLimit: view.pidsLimit,
    },
    node: { swapGb: row.swapGb },
    templates: db.select().from(templates).orderBy(templates.name).all(),
  };
}

function readRow(db: Db): RuntimeSettingsRow {
  const row = db
    .select()
    .from(runtimeSettings)
    .where(eq(runtimeSettings.id, SETTINGS_ROW_ID))
    .get();
  if (!row || row.configVersion === null) throw new NoConfigError();
  return row;
}

function toView(row: RuntimeSettingsRow): NodeSettings {
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
            // biome-ignore-start lint/style/noNonNullAssertion: a copy writes every column (applyNodeConfig), and readRow refuses anything that is not a copy
            bucket: row.s3Bucket!,
            region: row.s3Region!,
            forcePathStyle: row.s3ForcePathStyle!,
          },
    sandboxDomain: row.sandboxDomain,
    // The one writer JSON.stringifies an array; a corrupt value should
    // throw right here, not read as "no aliases".
    sandboxDomainAliases: JSON.parse(row.sandboxDomainAliases!) as string[],
    pidsLimit: row.pidsLimit!,
    // biome-ignore-end lint/style/noNonNullAssertion: a copy writes every column (applyNodeConfig), and readRow refuses anything that is not a copy
  };
}

/**
 * The node's managed-swap target — its own row at the gateway
 * (updateNodeSettings), applied by the boot reconcile in main.ts and by
 * node-config.ts when a bundle moves it.
 */
export function readSwapTarget(db: Db): number {
  return readRow(db).swapGb;
}

/**
 * The knobs in force, read fresh at each use site — a better-sqlite3 point
 * read costs microseconds, and reading live is what makes a bundle applied
 * a moment ago reach the very next acquire without a restart.
 */
export function readRuntimeSettings(db: Db): NodeSettings {
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
  if (row.s3Endpoint === null) return null;
  return {
    endpoint: row.s3Endpoint,
    // biome-ignore-start lint/style/noNonNullAssertion: the six columns write as one unit (applyNodeConfig)
    bucket: row.s3Bucket!,
    accessKeyId: row.s3AccessKeyId!,
    secretAccessKey: row.s3SecretAccessKey!,
    region: row.s3Region!,
    forcePathStyle: row.s3ForcePathStyle!,
    // biome-ignore-end lint/style/noNonNullAssertion: the six columns write as one unit (applyNodeConfig)
  };
}

/** The one adjudication of "is archiving available", read live. */
export function archiveEnabled(db: Db): boolean {
  return readS3Settings(db) !== null;
}
