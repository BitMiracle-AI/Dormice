import { z } from 'zod';

/**
 * All configuration comes from environment variables, validated once at
 * startup — a bad value fails loudly here instead of surfacing later as a
 * confusing runtime error. Everything except the API token has a default.
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
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}
