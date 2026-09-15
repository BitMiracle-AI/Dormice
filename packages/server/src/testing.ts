import {
  DEFAULT_LIFECYCLE_POLICY,
  type LifecyclePolicy,
  type NodeConfigBundle,
  type S3ArchiveSettings,
} from '@dormice/shared';
import type { Db } from './db/db';
import {
  applyNodeConfig,
  readConfigVersion,
  readNodeConfig,
} from './db/settings';
import { ARCHIVE_DEFAULT_SECONDS } from './policy';

/**
 * Test scaffolding for the suites that embed the daemon (this package's,
 * the SDK's, the CLI's): a configuration bundle with a few knobs turned,
 * applied the way a check-in would apply it. The daemon reads every knob
 * from its copy, so a test that wants a domain, a store or a template
 * configures the node instead of seeding an environment — the same
 * shape production takes, one write.
 */
export interface TestConfig {
  cpus?: number;
  memoryGb?: number;
  diskGb?: number;
  defaultPolicy?: LifecyclePolicy;
  /** A store turns the archive default on (one week), as the gateway's seed does. */
  s3?: S3ArchiveSettings | null;
  sandboxDomain?: string | null;
  sandboxDomainAliases?: string[];
  pidsLimit?: number;
  /** The fleet's base image; null (the default) = the fleet names none and the executor's own default stands in. */
  baseImage?: string | null;
  registryAddress?: string | null;
  swapGb?: number;
  /** Replaces the whole template list; timestamps are stamped now. */
  templates?: Array<{ name: string; image: string }>;
}

/** The exam's stand-in store: the four fields the ledger echoes back keyless, plus keys that must never reach a wire. */
export const TEST_S3: S3ArchiveSettings = {
  endpoint: 'http://127.0.0.1:9000',
  bucket: 'exam',
  accessKeyId: 'exam-key',
  secretAccessKey: 'exam-secret',
  region: 'us-east-1',
  forcePathStyle: true,
};

export function testBundle(
  over: TestConfig = {},
  version = 1,
  now = new Date(),
): NodeConfigBundle {
  const s3 = over.s3 ?? null;
  const stamp = now.toISOString();
  return {
    version,
    settings: {
      sandboxDefaults: {
        cpus: over.cpus ?? 1,
        memoryGb: over.memoryGb ?? 2,
        diskGb: over.diskGb ?? 10,
      },
      defaultPolicy: over.defaultPolicy ?? {
        ...DEFAULT_LIFECYCLE_POLICY,
        archiveAfterSeconds: s3 === null ? null : ARCHIVE_DEFAULT_SECONDS,
      },
      s3,
      sandboxDomain: over.sandboxDomain ?? null,
      sandboxDomainAliases: over.sandboxDomainAliases ?? [],
      pidsLimit: over.pidsLimit ?? 4096,
      baseImage: over.baseImage ?? null,
      registryAddress: over.registryAddress ?? null,
    },
    node: { swapGb: over.swapGb ?? 0 },
    templates: (over.templates ?? []).map((t) => ({
      ...t,
      createdAt: stamp,
      updatedAt: stamp,
    })),
  };
}

/**
 * Applies a bundle built from `over` on top of the copy the node already
 * holds (or the defaults when it holds none), one version up — a test's
 * "the gateway changed X" in one call. Templates given replace the list;
 * absent, the current list stays.
 */
export function configureNode(db: Db, over: TestConfig = {}): NodeConfigBundle {
  const current = readConfigVersion(db) === null ? null : readNodeConfig(db);
  const fresh = testBundle(over, (current?.version ?? 0) + 1);
  const bundle: NodeConfigBundle =
    current === null
      ? fresh
      : {
          version: fresh.version,
          settings: {
            sandboxDefaults:
              over.cpus !== undefined ||
              over.memoryGb !== undefined ||
              over.diskGb !== undefined
                ? fresh.settings.sandboxDefaults
                : current.settings.sandboxDefaults,
            defaultPolicy:
              over.defaultPolicy !== undefined || over.s3 !== undefined
                ? fresh.settings.defaultPolicy
                : current.settings.defaultPolicy,
            s3: over.s3 !== undefined ? over.s3 : current.settings.s3,
            sandboxDomain:
              over.sandboxDomain !== undefined
                ? over.sandboxDomain
                : current.settings.sandboxDomain,
            sandboxDomainAliases:
              over.sandboxDomainAliases ??
              current.settings.sandboxDomainAliases,
            pidsLimit: over.pidsLimit ?? current.settings.pidsLimit,
            baseImage:
              over.baseImage !== undefined
                ? over.baseImage
                : current.settings.baseImage,
            registryAddress:
              over.registryAddress !== undefined
                ? over.registryAddress
                : current.settings.registryAddress,
          },
          node: { swapGb: over.swapGb ?? current.node.swapGb },
          templates:
            over.templates !== undefined ? fresh.templates : current.templates,
        };
  applyNodeConfig(db, bundle);
  return bundle;
}

/**
 * Re-points (or adds) one template in the node's copy, the way the
 * gateway's registerTemplate then the next check-in would: the birth date
 * stays, the upgrade timestamp moves only when the image changes.
 */
export function registerTestTemplate(
  db: Db,
  name: string,
  image: string,
  now = new Date(),
): void {
  const current = readConfigVersion(db) === null ? null : readNodeConfig(db);
  const stamp = now.toISOString();
  const existing = current?.templates.find((t) => t.name === name);
  const templates = [
    ...(current?.templates.filter((t) => t.name !== name) ?? []),
    existing === undefined
      ? { name, image, createdAt: stamp, updatedAt: stamp }
      : existing.image === image
        ? existing
        : { ...existing, image, updatedAt: stamp },
  ].sort((a, b) => a.name.localeCompare(b.name));
  applyNodeConfig(db, {
    ...(current ?? testBundle()),
    version: (current?.version ?? 0) + 1,
    templates,
  });
}
