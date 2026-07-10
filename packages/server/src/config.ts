import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { S3Settings } from './archive/s3-store';

/**
 * All configuration comes from environment variables, validated once at
 * startup — a bad value fails loudly here instead of surfacing later as a
 * confusing runtime error. Everything has a default except the API token
 * and, when the docker executor is selected, the base image.
 *
 * Variables are prefixed DORMICE_ because the environment is a global
 * namespace — bare names like PORT collide with whatever else the operator
 * has exported.
 */
const envSchema = z.object({
  DORMICE_PORT: z.coerce.number().int().min(1).max(65535).default(3676),
  DORMICE_DB_PATH: z.string().default('data/dormice.db'),
  /** Identifies this machine in the ledger. Single-machine today; the field keeps the ledger shardable. */
  DORMICE_NODE_ID: z.string().default('node-1'),
  /** How often the idle scanner sweeps the ledger. */
  DORMICE_SCAN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  /**
   * How many sandboxes may exist at once. The binding resource is disk:
   * every sandbox holds a disk image, and an unbounded acquire loop fills
   * the host until the ledger itself can no longer write — the daemon dying
   * of its own success. Past the cap, acquire answers an honest 429; wakes
   * of existing sandboxes are never blocked.
   */
  DORMICE_MAX_SANDBOXES: z.coerce.number().int().positive().default(100),
  /**
   * Required, no default: loopback-only is not authentication — any local
   * process could otherwise drive the daemon.
   */
  DORMICE_API_TOKEN: z.string().min(32, {
    error:
      'DORMICE_API_TOKEN must be at least 32 characters — generate one with: openssl rand -hex 32',
  }),
  /**
   * Which executor drives reality: the in-memory fake (development, tests)
   * or real Docker+gVisor (needs a Linux host and root). Fake is the
   * default so a bare `pnpm dev` works on any machine.
   */
  DORMICE_EXECUTOR: z.enum(['fake', 'docker']).default('fake'),
  /** Image sandboxes boot from, e.g. dormice-base:20260708. Required by the docker executor. */
  DORMICE_BASE_IMAGE: z.string().optional(),
  /** Sandbox disk images and their mount points live here (docker executor only). */
  DORMICE_DATA_DIR: z.string().default('/var/lib/dormice'),
  DORMICE_SANDBOX_DISK_GB: z.coerce.number().positive().default(10),
  DORMICE_SANDBOX_CPUS: z.coerce.number().positive().default(1),
  DORMICE_SANDBOX_MEMORY_GB: z.coerce.number().positive().default(2),
  DORMICE_SANDBOX_PIDS_LIMIT: z.coerce.number().int().positive().default(512),
  DORMICE_RECLAIM_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(45),
  /**
   * The sandbox wildcard domain behind getHost(): with it set, create and
   * connect responses carry `domain`, the SDK builds
   * `<port>-<sandboxId>.<domain>` hosts, and requests arriving with such a
   * Host header are proxied into that sandbox's port (frozen sandboxes wake
   * on traffic). The operator points `*.<domain>` DNS plus a TLS-terminating
   * reverse proxy at the daemon. Unset, responses carry no domain and the
   * proxy never engages — the feature is honestly absent, not half-present.
   * A bare hostname: no scheme, no port, no leading or trailing dot.
   */
  DORMICE_SANDBOX_DOMAIN: z
    .string()
    .regex(
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
      {
        error:
          'DORMICE_SANDBOX_DOMAIN must be a bare hostname like sbx.example.com — no scheme, no port, no leading/trailing dots',
      },
    )
    .optional(),
  /**
   * The S3-compatible object store behind the archiver (AWS, R2, MinIO,
   * OSS in S3-compat mode). The four core variables come as a set: with
   * none of them, archiving is honestly absent — sandboxes park at stopped
   * forever, and policies asking to archive are refused (the
   * SANDBOX_DOMAIN precedent). Endpoint is a full URL including scheme
   * (MinIO speaks http, the clouds https).
   */
  DORMICE_S3_ENDPOINT: z
    .url({
      protocol: /^https?$/,
      error:
        'DORMICE_S3_ENDPOINT must be a full http(s) URL, e.g. https://s3.example.com or http://127.0.0.1:9000',
    })
    .optional(),
  DORMICE_S3_BUCKET: z.string().min(1).optional(),
  DORMICE_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  DORMICE_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  DORMICE_S3_REGION: z.string().default('us-east-1'),
  /** Path-style addressing: MinIO needs true; the clouds route by subdomain. */
  DORMICE_S3_FORCE_PATH_STYLE: z.stringbool().default(false),
});

const checkedSchema = envSchema
  .refine(
    (cfg) => cfg.DORMICE_EXECUTOR !== 'docker' || !!cfg.DORMICE_BASE_IMAGE,
    {
      message:
        'DORMICE_BASE_IMAGE is required when DORMICE_EXECUTOR=docker — build one from images/Dockerfile',
      path: ['DORMICE_BASE_IMAGE'],
    },
  )
  // Production discipline for real sandboxes: a relative ledger path
  // silently depends on the start directory, and a wrong start directory
  // means an empty ledger facing real sandboxes — the exact catastrophe
  // the startup guard exists to refuse. The fake executor keeps the
  // dev-friendly relative default; docker mode must not gamble.
  .refine(
    (cfg) =>
      cfg.DORMICE_EXECUTOR !== 'docker' || isAbsolute(cfg.DORMICE_DB_PATH),
    {
      message:
        'DORMICE_DB_PATH must be an absolute path when DORMICE_EXECUTOR=docker, e.g. /var/lib/dormice/dormice.db — a relative path depends on the start directory, and starting in the wrong directory opens a brand-new empty ledger next to real sandboxes',
      path: ['DORMICE_DB_PATH'],
    },
  )
  .refine(
    (cfg) =>
      cfg.DORMICE_EXECUTOR !== 'docker' || isAbsolute(cfg.DORMICE_DATA_DIR),
    {
      message:
        'DORMICE_DATA_DIR must be an absolute path when DORMICE_EXECUTOR=docker — sandbox disks must not move when the start directory does',
      path: ['DORMICE_DATA_DIR'],
    },
  )
  // All-or-none: a half-configured store would make the archiver's
  // existence ambiguous, and ambiguity here decides real policy defaults.
  .superRefine((cfg, ctx) => {
    const wanted = [
      'DORMICE_S3_ENDPOINT',
      'DORMICE_S3_BUCKET',
      'DORMICE_S3_ACCESS_KEY_ID',
      'DORMICE_S3_SECRET_ACCESS_KEY',
    ] as const;
    const missing = wanted.filter((name) => cfg[name] === undefined);
    const first = missing[0];
    if (first !== undefined && missing.length < wanted.length) {
      ctx.addIssue({
        code: 'custom',
        message: `the DORMICE_S3_* variables come as a set: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing — set all four to enable the archiver, or none to disable it`,
        path: [first],
      });
    }
  });

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return checkedSchema.parse(env);
}

/**
 * The single adjudicator of "is the archiver configured": null unless the
 * whole S3 set is present (a partial set never gets past the schema). What
 * hangs off this one answer: whether an Archiver is built at boot, whether
 * new sandboxes default to archiving, and whether archive-asking policy
 * overrides are accepted at all.
 */
export function s3Settings(config: Config): S3Settings | null {
  if (
    config.DORMICE_S3_ENDPOINT === undefined ||
    config.DORMICE_S3_BUCKET === undefined ||
    config.DORMICE_S3_ACCESS_KEY_ID === undefined ||
    config.DORMICE_S3_SECRET_ACCESS_KEY === undefined
  ) {
    return null;
  }
  return {
    endpoint: config.DORMICE_S3_ENDPOINT,
    bucket: config.DORMICE_S3_BUCKET,
    accessKeyId: config.DORMICE_S3_ACCESS_KEY_ID,
    secretAccessKey: config.DORMICE_S3_SECRET_ACCESS_KEY,
    region: config.DORMICE_S3_REGION,
    forcePathStyle: config.DORMICE_S3_FORCE_PATH_STYLE,
  };
}
