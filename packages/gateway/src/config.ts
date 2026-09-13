import { isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * The gateway's configuration: environment variables, validated once at
 * startup so a bad value fails loudly here — the daemon's discipline
 * (packages/server/src/config.ts). The gateway's own knobs carry the
 * DORMICE_GATEWAY_ prefix so a gateway and a node can share one machine's
 * /etc/dormice without colliding; the token deliberately does not — it is
 * the very same DORMICE_API_TOKEN every node has, one string for the whole
 * fleet, written into both env files by the same hand.
 */
const envSchema = z.object({
  DORMICE_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(3677),
  /**
   * Absolute, like the daemon's in docker mode and for the same reason: a
   * relative path depends on the start directory, and under systemd (no
   * WorkingDirectory) that is `/` — a gateway started without this variable
   * would keep its tables in /data, silently, until the day someone sets
   * the path and every node it ever knew is gone.
   */
  DORMICE_GATEWAY_DB_PATH: z
    .string()
    .default('/var/lib/dormice-gateway/gateway.db')
    .refine((path) => path === ':memory:' || isAbsolute(path), {
      error:
        'DORMICE_GATEWAY_DB_PATH must be an absolute path, e.g. /var/lib/dormice-gateway/gateway.db',
    }),
  /**
   * The one token of the fleet. Callers present it to the gateway, nodes
   * present it when they check in, and the gateway presents it to nodes
   * when it forwards. Required, no default: loopback-only is not
   * authentication.
   */
  DORMICE_API_TOKEN: z.string().min(32, {
    error:
      'DORMICE_API_TOKEN must be at least 32 characters — generate one with: openssl rand -hex 32',
  }),
  /**
   * Placement: a node whose last whole-machine CPU reading is above this
   * takes no new sandboxes. 70 leaves the headroom a wake burst needs —
   * the 2026-09-11 Beijing incident saturated a 128-core host from a
   * reading well under 100 in one burst of cold starts.
   */
  DORMICE_GATEWAY_NODE_CPU_LIMIT_PCT: z.coerce
    .number()
    .min(0)
    .max(100)
    .default(70),
  /**
   * Placement: a node already running this many active sandboxes (plus
   * those placed on it since its last check-in) takes no more. Active
   * only — frozen sandboxes cost swap, not CPU or dockerd attention, and
   * a node holds thousands of them; the ceiling this guards is running
   * containers per host.
   */
  DORMICE_GATEWAY_NODE_ACTIVE_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(400),
  /**
   * Placement: a node whose data disk has less than this free takes no new
   * sandboxes. Ten GiB is one default sandbox disk: below that, a single
   * new sandbox writing its disk full would fill the host, and a full data
   * disk is the one failure that stops every sandbox on the node at once
   * (the ledger itself cannot write). The node's own create still answers
   * its honest 500 past this point; the gate is what keeps the next ten
   * names from landing on the same full box.
   */
  DORMICE_GATEWAY_NODE_MIN_DISK_GB: z.coerce.number().nonnegative().default(10),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}
