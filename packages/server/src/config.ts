import { isAbsolute } from 'node:path';
import { isOriginUrl } from '@dormice/shared';
import { z } from 'zod';

/**
 * All configuration comes from environment variables, validated once at
 * startup — a bad value fails loudly here instead of surfacing later as a
 * confusing runtime error. Everything has a default except the API token
 * and, when the docker executor is selected, the base image.
 *
 * What is here is the node's identity and its machine: port, ledger, data
 * dir, executor, token, the gateway it belongs to, its tickers. The
 * fleet's operator knobs — new-sandbox defaults, the pids cap, the S3
 * store, the sandbox domain, the managed front door — are not: since the
 * configuration moved to the gateway (2026-09-14, design record #22) they
 * are the gateway's env seeds and its console's knobs, and reach this
 * node as a bundle with its check-in (db/settings.ts). Their old variable
 * names are still recognised here for one purpose: to say at boot that
 * they do nothing (MOVED_TO_GATEWAY below).
 *
 * Variables are prefixed DORMICE_ because the environment is a global
 * namespace — bare names like PORT collide with whatever else the operator
 * has exported.
 */

/**
 * The ceiling on every knob that becomes a Node timer — the three
 * intervals and the reclaim timeout: one day. A day is the slowest
 * cadence, and the longest bound, that still means anything — and past
 * 2^31-1 ms (24.8 days) Node's timers do not wait at all: setTimeout
 * warns and fires after one millisecond (TimeoutOverflowWarning), and
 * execa's timeout rides the same timer. A sweep, a sample or a check-in
 * every millisecond; a memory.reclaim killed at once on every freeze and
 * logged as the expected cut-short, the idle sandboxes' memory never
 * squeezed out. Refused at boot instead (found by review, 2026-09-15;
 * the gateway's sampler knob carries the same rule, gateway/config.ts).
 */
const MAX_TIMER_SECONDS = 86_400;

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
  DORMICE_SCAN_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_TIMER_SECONDS)
    .default(60),
  /**
   * How often the metrics sampler persists a reading per measurable sandbox
   * plus one fleet state-count row — the resolution of every history curve.
   */
  DORMICE_METRICS_SAMPLE_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_TIMER_SECONDS)
    .default(30),
  /**
   * How long per-sandbox samples live (fleet rows are fixed at 30 days —
   * HOST_SAMPLE_KEEP_DAYS). A knob because volume scales with the fleet:
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
  /**
   * The image template-less sandboxes boot from — a fleet setting since
   * the fourth cut (shared settings.ts baseImage: every node shares one
   * base, pulled from the fleet registry), and this variable is the
   * node's fallback while the fleet's settings name none (a node upgraded
   * before its gateway learned the knob; db/templates.ts
   * resolveBaseImage). main.ts says at boot which of the two is in force.
   * Until 2026-09-15 this was the knob's only home and required in docker
   * mode; a node without it now refuses only at the moment a sandbox
   * would need a base image and the fleet has none.
   */
  DORMICE_BASE_IMAGE: z.string().regex(/^\S+$/).optional(),
  /** Sandbox disk images and their mount points live here (docker executor only). */
  DORMICE_DATA_DIR: z.string().default('/var/lib/dormice'),
  /**
   * Upper bound on a freeze's memory.reclaim write (executor/docker.ts
   * reclaimMemory) — a SIGKILL deadline on the writer, so a Node timer
   * too, and capped like the intervals (MAX_TIMER_SECONDS): overflowed,
   * every reclaim would be killed after one millisecond and logged as
   * the expected cut-short, and idle would stop being free.
   */
  DORMICE_RECLAIM_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_TIMER_SECONDS)
    .default(45),
  /**
   * The gateway this daemon is a node of — its intranet address, e.g.
   * http://10.0.0.5:3677. The daemon checks in with it every
   * DORMICE_CHECK_IN_INTERVAL_SECONDS (check-in.ts): its readings, its
   * build, where it can be reached, and which configuration version it
   * runs — and takes the fleet's configuration from the answer. That
   * check-in is the gateway's only source of "which nodes exist and how
   * full are they" — no registration, no nodes file — and the node's only
   * source of its settings and templates. Every daemon is a node of a
   * gateway (design record #22: a single machine is a fleet of one); the
   * default is the gateway install.sh puts beside the daemon. The token
   * it presents is DORMICE_API_TOKEN: gateway and nodes share one, and
   * the gateway speaks to every node with the same one.
   */
  DORMICE_GATEWAY_ENDPOINT: z
    .url({
      protocol: /^https?$/,
      error:
        'DORMICE_GATEWAY_ENDPOINT must be a full http(s) URL, e.g. http://10.0.0.5:3677',
    })
    .transform((url) => url.replace(/\/+$/, ''))
    .default('http://127.0.0.1:3677'),
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
    .max(MAX_TIMER_SECONDS)
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
      isLoopbackUrl(cfg.DORMICE_GATEWAY_ENDPOINT) !== false ||
      cfg.DORMICE_NODE_ID !== 'node-1',
    {
      message:
        'DORMICE_NODE_ID is required when DORMICE_GATEWAY_ENDPOINT is not loopback: the gateway tells nodes apart by it, and node-1 (the default) is what every other unconfigured node says — the second to check in is refused as a twin. Give this node a name of its own, e.g. its hostname',
      path: ['DORMICE_NODE_ID'],
    },
  );

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return checkedSchema.parse(env);
}

/**
 * The fleet's operator knobs, by their old daemon names — variables this
 * process reads nothing from since the configuration moved to the gateway
 * (2026-09-14). They live on the gateway's side now: as its env seeds at
 * first start (same names), then in its settings table, edited from the
 * console. A node that still carries them in its env file is a machine
 * upgraded across the move; main.ts says so once at boot, naming them,
 * instead of silently doing something else than the operator wrote.
 */
export const MOVED_TO_GATEWAY = [
  'DORMICE_SANDBOX_DISK_GB',
  'DORMICE_SANDBOX_CPUS',
  'DORMICE_SANDBOX_MEMORY_GB',
  'DORMICE_SANDBOX_PIDS_LIMIT',
  'DORMICE_SANDBOX_DOMAIN',
  'DORMICE_INGRESS_FILE',
  'DORMICE_INGRESS_RELOAD_CMD',
  'DORMICE_S3_ENDPOINT',
  'DORMICE_S3_BUCKET',
  'DORMICE_S3_ACCESS_KEY_ID',
  'DORMICE_S3_SECRET_ACCESS_KEY',
  'DORMICE_S3_REGION',
  'DORMICE_S3_FORCE_PATH_STYLE',
] as const;

/** Which of MOVED_TO_GATEWAY the environment still sets, for the boot line. */
export function ignoredEnvKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return MOVED_TO_GATEWAY.filter((key) => env[key] !== undefined);
}
