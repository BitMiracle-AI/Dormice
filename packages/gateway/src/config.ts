import { isAbsolute } from 'node:path';
import type { S3Settings } from '@dormice/server/s3-store';
import { bareHostnameRegex, PIDS_LIMIT_MIN } from '@dormice/shared';
import { z } from 'zod';

/**
 * The gateway's configuration: environment variables, validated once at
 * startup so a bad value fails loudly here — the daemon's discipline
 * (packages/server/src/config.ts). The gateway's own knobs carry the
 * DORMICE_GATEWAY_ prefix so a gateway and a node can share one machine's
 * /etc/dormice without colliding; the token deliberately does not — it is
 * the very same DORMICE_API_TOKEN every node has, one string for the whole
 * fleet, written into both env files by the same hand.
 *
 * The fleet's operator knobs (new-sandbox defaults, the pids cap, the S3
 * store, the sandbox domain) are first-boot seeds only: the gateway's
 * first start writes them into its settings table (db/settings.ts), and
 * from then on the table is the one truth, edited from the console or
 * updateSettings; a later env edit of these is deliberately ignored — two
 * live sources for one knob is a standing ambiguity. They keep the
 * daemon's old names so an operator moving a single machine onto the
 * gateway copies the lines across, nothing more.
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
  /**
   * How often the gateway writes one row of the fleet's state census —
   * the data behind the console's concurrency curve (db/fleet-samples.ts).
   * The gateway's one clock of its own: a row per tick keeps the table
   * the same size for a fleet of one and a fleet of ten, where a row per
   * node check-in grew with the fleet. 30, the daemon's own sampling
   * interval, so a single node's imported history and the gateway's join
   * at the same density; the exam sets 1.
   */
  DORMICE_GATEWAY_SAMPLE_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30),
  // ---- first-boot seeds of the settings table, in the daemon's words ----
  DORMICE_SANDBOX_DISK_GB: z.coerce.number().positive().default(10),
  DORMICE_SANDBOX_CPUS: z.coerce.number().positive().default(1),
  DORMICE_SANDBOX_MEMORY_GB: z.coerce.number().positive().default(2),
  /**
   * The pids cgroup cap on each sandbox's container, fleet-wide. Under
   * gVisor it caps the sandbox's host-side footprint, not a count the
   * guest can see, and hitting it kills the whole sandbox (exit 2, no OOM
   * flag; measured 2026-09-08). 4096 is ~8x the peak a real agent sandbox
   * was seen at. Floored at the wire's PIDS_LIMIT_MIN: the settings view
   * promises that floor, so a lower seed would leave getConfig unable to
   * serialize its own settings — refused here, at boot, named.
   */
  DORMICE_SANDBOX_PIDS_LIMIT: z.coerce
    .number()
    .int()
    .min(PIDS_LIMIT_MIN, {
      error: `DORMICE_SANDBOX_PIDS_LIMIT must be at least ${PIDS_LIMIT_MIN} — below that a sandbox cannot boot its own runtime`,
    })
    .default(4096),
  /**
   * The sandbox wildcard domain behind getHost() and port previews. A bare
   * hostname — the same regex the wire validates against.
   */
  DORMICE_SANDBOX_DOMAIN: z
    .string()
    .regex(bareHostnameRegex, {
      error:
        'DORMICE_SANDBOX_DOMAIN must be a bare hostname like sbx.example.com — no scheme, no port, no leading/trailing dots',
    })
    .optional(),
  /**
   * The S3-compatible object store behind every node's archiver (AWS, R2,
   * MinIO, OSS in S3-compat mode). The four core variables come as a set
   * — a half-configured seed refuses to boot; none of them seeds
   * "archiving off", which the console can turn on at any time.
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
  /**
   * The Caddy config file the gateway owns — the switch for web-based
   * domain binding (setIngress rewrites the file, reloads Caddy, Caddy
   * handles the certificate). Unset, the gateway never touches any proxy
   * config and setIngress is refused — the feature is honestly absent.
   * Absolute: a system file must not move with the start directory.
   */
  DORMICE_INGRESS_FILE: z
    .string()
    .refine(isAbsolute, {
      error:
        'DORMICE_INGRESS_FILE must be an absolute path, e.g. /etc/caddy/Caddyfile',
    })
    .optional(),
  /**
   * How the gateway tells the running proxy to re-read its config after a
   * bind. Defaults to `caddy reload --config <DORMICE_INGRESS_FILE>`; an
   * operator whose own Caddyfile imports a Dormice-owned fragment points
   * this at the outer file instead.
   */
  DORMICE_INGRESS_RELOAD_CMD: z.string().min(1).optional(),
});

// All-or-none: a half-configured store would make "is archiving on"
// ambiguous, and that answer decides real policy defaults.
const checkedSchema = envSchema.superRefine((cfg, ctx) => {
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
      message: `the DORMICE_S3_* variables come as a set: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing — set all four to seed the archive store, or none to leave archiving off`,
      path: [first],
    });
  }
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return checkedSchema.parse(env);
}

/**
 * Every knob the gateway has, in display order, with its secrecy flag —
 * the single adjudication of "what getConfig reports". A Record over keyof
 * Config so the compiler refuses a new env variable until it is listed
 * here too: a knob that exists but is invisible would be a silent lie.
 */
export const CONFIG_KEYS: Record<keyof Config, { sensitive: boolean }> = {
  DORMICE_GATEWAY_PORT: { sensitive: false },
  DORMICE_GATEWAY_DB_PATH: { sensitive: false },
  DORMICE_API_TOKEN: { sensitive: true },
  DORMICE_GATEWAY_NODE_CPU_LIMIT_PCT: { sensitive: false },
  DORMICE_GATEWAY_NODE_ACTIVE_LIMIT: { sensitive: false },
  DORMICE_GATEWAY_NODE_MIN_DISK_GB: { sensitive: false },
  DORMICE_GATEWAY_SAMPLE_INTERVAL_SECONDS: { sensitive: false },
  DORMICE_SANDBOX_DISK_GB: { sensitive: false },
  DORMICE_SANDBOX_CPUS: { sensitive: false },
  DORMICE_SANDBOX_MEMORY_GB: { sensitive: false },
  DORMICE_SANDBOX_PIDS_LIMIT: { sensitive: false },
  DORMICE_SANDBOX_DOMAIN: { sensitive: false },
  DORMICE_S3_ENDPOINT: { sensitive: false },
  DORMICE_S3_BUCKET: { sensitive: false },
  DORMICE_S3_ACCESS_KEY_ID: { sensitive: true },
  DORMICE_S3_SECRET_ACCESS_KEY: { sensitive: true },
  DORMICE_S3_REGION: { sensitive: false },
  DORMICE_S3_FORCE_PATH_STYLE: { sensitive: false },
  DORMICE_INGRESS_FILE: { sensitive: false },
  DORMICE_INGRESS_RELOAD_CMD: { sensitive: false },
};

export type ConfigSources = Record<keyof Config, 'env' | 'default'>;

/**
 * Which knobs the operator set explicitly versus which fell back to
 * defaults. Read off the raw environment at load time — the parsed config
 * cannot tell the two apart once defaults are applied.
 */
export function configSources(
  env: NodeJS.ProcessEnv = process.env,
): ConfigSources {
  return Object.fromEntries(
    (Object.keys(CONFIG_KEYS) as Array<keyof Config>).map((key) => [
      key,
      env[key] !== undefined ? 'env' : 'default',
    ]),
  ) as ConfigSources;
}

/** The S3 first-boot seed: null unless the whole DORMICE_S3_* set is present (a partial set never gets past the schema). */
export function s3Seed(config: Config): S3Settings | null {
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
