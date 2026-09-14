import { isAbsolute } from 'node:path';
import {
  bareHostnameRegex,
  isOriginUrl,
  PIDS_LIMIT_MIN,
} from '@dormice/shared';
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
  /**
   * This node's name: in its ledger's rows, and to its gateway, which
   * tells nodes apart by it. The default serves a daemon that is the
   * whole platform, or shares its machine with its gateway; a node whose
   * gateway is elsewhere must state its own (checkedSchema below).
   */
  DORMICE_NODE_ID: z.string().min(1).default('node-1'),
  /** How often the idle scanner sweeps the ledger. */
  DORMICE_SCAN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  /**
   * How often the metrics sampler persists a reading per measurable sandbox
   * plus one fleet state-count row — the resolution of every history curve.
   */
  DORMICE_METRICS_SAMPLE_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30),
  /**
   * How long per-sandbox samples live (fleet rows are fixed at 30 days —
   * FLEET_SNAPSHOT_KEEP_DAYS). A knob because volume scales with the fleet:
   * at the 30s default, a worst-case 100 always-hot sandboxes over the
   * default 7 days is ~2M rows — fine for SQLite, but the operator of such
   * a box may want to trade history depth for disk.
   */
  DORMICE_METRICS_RETENTION_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .default(168),
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
  /**
   * The pids cgroup cap on each sandbox's container. Under gVisor this is
   * NOT "how many processes the sandbox may run": the guest never sees it.
   * It caps the sandbox's host-side footprint — the sentry's threads, the
   * gofer, and one stub process per guest process (systrap) — and when the
   * cap is hit the Go runtime cannot create a thread and the whole sandbox
   * dies (exit 2, no OOM flag; measured 2026-09-08). 512 was runc's
   * fork-bomb number and killed real 16 GB agent sandboxes running a browser
   * plus several node/claude sessions (a production fleet: 13 deaths in 10 days,
   * observed peak 470). 4096 is ~8x that peak; the cap still exists so a
   * fork bomb takes down its own sandbox and nothing else. A first-boot
   * seed since the same day (runtime_settings.pids_limit, edited from the
   * console settings page): the incident that earned the new default was
   * exactly an operator needing to move this without shell access and a
   * restart. Existing containers converge at their next wake (docker
   * update, no rebuild). Floored at the wire's PIDS_LIMIT_MIN: the settings
   * view promises that floor, so a lower seed adopted into the ledger would
   * leave getConfig unable to serialize its own settings (measured: HTTP
   * 500 on every call) — refused here, at boot, with the variable named.
   */
  DORMICE_SANDBOX_PIDS_LIMIT: z.coerce
    .number()
    .int()
    .min(PIDS_LIMIT_MIN, {
      error: `DORMICE_SANDBOX_PIDS_LIMIT must be at least ${PIDS_LIMIT_MIN} — below that a sandbox cannot boot its own runtime`,
    })
    .default(4096),
  DORMICE_RECLAIM_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(45),
  /**
   * The sandbox wildcard domain behind getHost() — first-boot seed only
   * since 2026-07-26: the value in force lives in the ledger
   * (runtime_settings.sandbox_domain, edited from the console domains
   * page), and once that column holds a value this variable is
   * deliberately ignored. With a domain in force, create and connect
   * responses carry `domain`, the SDK builds `<port>-<sandboxId>.<domain>`
   * hosts, and requests arriving with such a Host header are proxied into
   * that sandbox's port (frozen sandboxes wake on traffic). The operator
   * points `*.<domain>` DNS plus a TLS-terminating reverse proxy at the
   * daemon. A bare hostname: no scheme, no port, no leading or trailing
   * dot — the same regex the wire validates against (shared/settings.ts).
   */
  DORMICE_SANDBOX_DOMAIN: z
    .string()
    .regex(bareHostnameRegex, {
      error:
        'DORMICE_SANDBOX_DOMAIN must be a bare hostname like sbx.example.com — no scheme, no port, no leading/trailing dots',
    })
    .optional(),
  /**
   * The Caddy config file the daemon owns — the switch for web-based domain
   * binding (setIngress rewrites the file, reloads Caddy, Caddy handles the
   * certificate). install.sh sets it when it installs Caddy. Unset, the
   * daemon never touches any proxy config and setIngress is refused — the
   * feature is honestly absent (the SANDBOX_DOMAIN precedent). Absolute:
   * a system file must not move with the start directory.
   */
  DORMICE_INGRESS_FILE: z
    .string()
    .refine(isAbsolute, {
      error:
        'DORMICE_INGRESS_FILE must be an absolute path, e.g. /etc/caddy/Caddyfile',
    })
    .optional(),
  /**
   * How the daemon tells the running proxy to re-read its config after a
   * bind. Defaults to `caddy reload --config <DORMICE_INGRESS_FILE>` —
   * right when the daemon owns the whole Caddyfile; an operator whose own
   * Caddyfile imports a Dormice-owned fragment points this at the outer
   * file instead.
   */
  DORMICE_INGRESS_RELOAD_CMD: z.string().min(1).optional(),
  /**
   * The S3-compatible object store behind the archiver (AWS, R2, MinIO,
   * OSS in S3-compat mode) — first-boot seeds only since 2026-07-26: the
   * store in force lives in the ledger (runtime_settings.s3_*, edited from
   * the console settings page), and once those columns hold a value these
   * variables are deliberately ignored. The four core variables still come
   * as a set (a half-configured seed refuses to boot, same as ever); with
   * none of them, the seed is "archiving off" — the console can turn it on
   * at any time. Endpoint is a full URL including scheme (MinIO speaks
   * http, the clouds https).
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
   * The gateway this daemon is a node of — its intranet address, e.g.
   * http://10.0.0.5:3677. Set, the daemon checks in with it every
   * DORMICE_CHECK_IN_INTERVAL_SECONDS (check-in.ts): its readings, its
   * build, and where it can be reached. That check-in is the gateway's
   * only source of "which nodes exist and how full are they" — no
   * registration, no nodes file. Unset, the daemon is the whole platform
   * by itself, as it always was, and checks in with nobody. The token it
   * presents is DORMICE_API_TOKEN: gateway and nodes share one, and the
   * gateway speaks to every node with the same one.
   */
  DORMICE_GATEWAY_ENDPOINT: z
    .url({
      protocol: /^https?$/,
      error:
        'DORMICE_GATEWAY_ENDPOINT must be a full http(s) URL, e.g. http://10.0.0.5:3677',
    })
    .transform((url) => url.replace(/\/+$/, ''))
    .optional(),
  /**
   * Where the gateway reaches this node — the address it forwards to.
   * Default: this daemon's own loopback address, right when gateway and
   * node share a machine (the single-machine install is a fleet of one).
   * On a machine of its own the daemon still binds loopback (the red
   * line), so this names the front the gateway may dial — the node's
   * Caddy on the intranet interface, e.g. http://10.0.0.7:80 — and is
   * required there (checkedSchema below): left at the default, the node
   * would tell a remote gateway to dial 127.0.0.1, an address on the
   * gateway's own machine, and every sandbox placed "here" would land on
   * whatever daemon lives there and be found twice.
   */
  DORMICE_NODE_ENDPOINT: z
    .url({
      protocol: /^https?$/,
      error:
        'DORMICE_NODE_ENDPOINT must be a full http(s) URL, e.g. http://10.0.0.7:80',
    })
    .transform((url) => url.replace(/\/+$/, ''))
    // An origin, nothing more (shared endpointSchema has the measurement):
    // the gateway would answer this node's every check-in with a 400
    // otherwise — refused here, at boot, where the operator is looking.
    .refine(isOriginUrl, {
      error:
        "DORMICE_NODE_ENDPOINT must name the node's front without a path — scheme, host and port only, e.g. http://10.0.0.7:80 (the gateway dials <endpoint>/<verb>)",
    })
    .optional(),
  /**
   * How often the node checks in with its gateway. The gateway reads two
   * missed check-ins as down — the one number both ends of that wire
   * share, so the node states it in every check-in.
   */
  DORMICE_CHECK_IN_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15),
});

/**
 * Loopback as an operator writes it: 127.0.0.0/8, ::1, localhost. Null
 * when the URL does not parse — its own field has already said so, and an
 * object-level rule must not throw over it (zod runs the refinements even
 * when a field failed).
 */
function isLoopbackUrl(url: string): boolean | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('127.')
  );
}

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
  // A node whose gateway is on another machine must say where it is. The
  // check-in's default endpoint is this daemon's loopback address, which
  // on the gateway's machine names the gateway's own daemon (or nothing):
  // a remote gateway dialing 127.0.0.1 for this node would place sandboxes
  // on the wrong machine and then find every one of them twice (409). An
  // explicit value is the operator's word and is taken as written.
  .refine(
    (cfg) =>
      cfg.DORMICE_GATEWAY_ENDPOINT === undefined ||
      isLoopbackUrl(cfg.DORMICE_GATEWAY_ENDPOINT) !== false ||
      cfg.DORMICE_NODE_ENDPOINT !== undefined,
    {
      message:
        "DORMICE_NODE_ENDPOINT is required when DORMICE_GATEWAY_ENDPOINT is not loopback: the gateway is on another machine, and without it this node would report http://127.0.0.1:<DORMICE_PORT> — an address on the gateway's machine, not this one. Name this node's address on the network, e.g. http://10.0.0.7:80",
      path: ['DORMICE_NODE_ENDPOINT'],
    },
  )
  // ...and who it is. The gateway tells nodes apart by DORMICE_NODE_ID,
  // and node-1 is what every other unconfigured node says too: the
  // second node-1 to check in is refused as a twin (409) at every
  // check-in — or, when the first has been silent for an interval, taken
  // for it having moved, and the first's names are placed again
  // elsewhere. Refused here, at boot, where the operator is looking.
  .refine(
    (cfg) =>
      cfg.DORMICE_GATEWAY_ENDPOINT === undefined ||
      isLoopbackUrl(cfg.DORMICE_GATEWAY_ENDPOINT) !== false ||
      cfg.DORMICE_NODE_ID !== 'node-1',
    {
      message:
        'DORMICE_NODE_ID is required when DORMICE_GATEWAY_ENDPOINT is not loopback: the gateway tells nodes apart by it, and node-1 (the default) is what every other unconfigured node says — the second to check in is refused as a twin. Give this node a name of its own, e.g. its hostname',
      path: ['DORMICE_NODE_ID'],
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
 * Every knob the daemon has, in display order, with its secrecy flag — the
 * single adjudication of "what getConfig reports". A Record over keyof
 * Config so the compiler refuses a new env variable until it is listed
 * here too: a knob that exists but is invisible would be a silent lie.
 */
export const CONFIG_KEYS: Record<keyof Config, { sensitive: boolean }> = {
  DORMICE_PORT: { sensitive: false },
  DORMICE_DB_PATH: { sensitive: false },
  DORMICE_NODE_ID: { sensitive: false },
  DORMICE_API_TOKEN: { sensitive: true },
  DORMICE_EXECUTOR: { sensitive: false },
  DORMICE_BASE_IMAGE: { sensitive: false },
  DORMICE_DATA_DIR: { sensitive: false },
  DORMICE_SCAN_INTERVAL_SECONDS: { sensitive: false },
  DORMICE_METRICS_SAMPLE_INTERVAL_SECONDS: { sensitive: false },
  DORMICE_METRICS_RETENTION_HOURS: { sensitive: false },
  DORMICE_SANDBOX_DISK_GB: { sensitive: false },
  DORMICE_SANDBOX_CPUS: { sensitive: false },
  DORMICE_SANDBOX_MEMORY_GB: { sensitive: false },
  DORMICE_SANDBOX_PIDS_LIMIT: { sensitive: false },
  DORMICE_RECLAIM_TIMEOUT_SECONDS: { sensitive: false },
  DORMICE_SANDBOX_DOMAIN: { sensitive: false },
  DORMICE_INGRESS_FILE: { sensitive: false },
  DORMICE_INGRESS_RELOAD_CMD: { sensitive: false },
  DORMICE_S3_ENDPOINT: { sensitive: false },
  DORMICE_S3_BUCKET: { sensitive: false },
  DORMICE_S3_ACCESS_KEY_ID: { sensitive: true },
  DORMICE_S3_SECRET_ACCESS_KEY: { sensitive: true },
  DORMICE_S3_REGION: { sensitive: false },
  DORMICE_S3_FORCE_PATH_STYLE: { sensitive: false },
  DORMICE_GATEWAY_ENDPOINT: { sensitive: false },
  DORMICE_NODE_ENDPOINT: { sensitive: false },
  DORMICE_CHECK_IN_INTERVAL_SECONDS: { sensitive: false },
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

/**
 * The one adjudicator of the S3 first-boot seed: null unless the whole
 * DORMICE_S3_* set is present (a partial set never gets past the schema).
 * Since 2026-07-26 this decides only what ensureRuntimeSettings seeds a
 * virgin ledger with — the store in force is the ledger's
 * (db/settings.ts readS3Settings), and everything that used to hang off
 * this answer (whether the Archiver has a store, whether new sandboxes
 * default to archiving, whether archive-asking policies are accepted)
 * reads the ledger live.
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
