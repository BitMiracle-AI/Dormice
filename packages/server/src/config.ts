import { z } from 'zod';

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
});

const checkedSchema = envSchema.refine(
  (cfg) => cfg.DORMICE_EXECUTOR !== 'docker' || !!cfg.DORMICE_BASE_IMAGE,
  {
    message:
      'DORMICE_BASE_IMAGE is required when DORMICE_EXECUTOR=docker — build one from images/Dockerfile',
    path: ['DORMICE_BASE_IMAGE'],
  },
);

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return checkedSchema.parse(env);
}
