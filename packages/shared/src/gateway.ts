import { z } from 'zod';
import {
  dataDiskSchema,
  hostReadingSchema,
  isoTimestampSchema,
  sandboxDisksSchema,
  sandboxStateCountsSchema,
} from './host';
import { lifecyclePolicySchema } from './policy';
import {
  bareHostnameRegex,
  PIDS_LIMIT_MIN,
  s3ArchiveSettingsSchema,
  sandboxResourceDefaultsSchema,
} from './settings';
import { templateSchema } from './templates';

/**
 * The gateway's wire: the verbs between a node and the gateway that fronts
 * it, and the gateway's own observation verbs. A fleet is N daemons that
 * know nothing of each other behind one gateway that holds no sandbox
 * state — only what the nodes tell it every few seconds and what its own
 * configuration tables say. A single machine runs the same two processes
 * and is a fleet of one.
 */

/** The identity a build carries: the commit its dist was built from. Null where the dist was built outside a checkout. */
export const buildInfoSchema = z.object({
  /** Short hash. */
  commit: z.string(),
  /** The commit's subject line. */
  title: z.string(),
  /** ISO 8601 UTC — the commit's time, not the build's. */
  committedAt: z.iso.datetime(),
});

export type BuildInfo = z.infer<typeof buildInfoSchema>;

/**
 * Whether a URL is an origin and nothing more: scheme, host and port — no
 * path, query or fragment. False for a string that is not a URL at all.
 */
export function isOriginUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
}

/**
 * Where a process can be dialled — an origin. The gateway joins
 * `<endpoint>/<verb>` for its own lookup and hands the endpoint to undici
 * as the request's origin when it forwards, and undici refuses an origin
 * that carries a path (UND_ERR_INVALID_ARG, measured 2026-09-14): a node
 * reporting `http://10.0.0.7:80/dormice` would be found by every lookup
 * and reached by no forward. So a path is refused at the wire. A trailing
 * slash is dropped rather than refused — the same address to everyone but
 * a string compare, and the two ends must agree byte for byte (the join
 * above would otherwise ask for `//lookupSandbox`, a 404 the gateway reads
 * as silence).
 */
export const endpointSchema = z
  .url({ protocol: /^https?$/ })
  .transform((url) => url.replace(/\/+$/, ''))
  .refine(isOriginUrl, {
    error:
      'an endpoint is an origin — scheme, host and port only, no path or query, e.g. http://10.0.0.7:80',
  });

/**
 * What a node reports about itself at every check-in — everything
 * placement decides on: the machine's CPU, memory and data disk, and the
 * ledger's census by state. The same host reading getHostMetrics answers
 * (host.ts), minus the daemon-local knobs no gateway places by.
 */
export const nodeReadingSchema = z.object({
  host: hostReadingSchema,
  dataDisk: dataDiskSchema.nullable(),
  sandboxes: z.object({
    total: z.number().int(),
    byState: sandboxStateCountsSchema,
  }),
  /**
   * The daemon-managed swap on this node's data disk (server/swap.ts):
   * what is mounted right now. Null where the daemon cannot manage swap
   * at all — a non-Linux host, the fake executor — so the gateway refuses
   * a target for this node (updateNodeSettings) instead of storing one
   * nothing will ever reconcile.
   */
  managedSwap: z
    .object({ activeGb: z.number().int().nonnegative() })
    .nullable(),
  /**
   * What this node's sandbox disks cost (host.ts sandboxDisksSchema), so
   * the fleet's bill is a sum the gateway already holds (getFleetMetrics)
   * and no console poll has to ask the nodes. Optional on the wire for one
   * reason: a rolling upgrade takes the gateway first, and a node still on
   * a build before the third cut (2026-09-14) reports without it — its
   * check-in is taken, not refused with a 400 for the length of the
   * upgrade.
   */
  sandboxDisks: sandboxDisksSchema.optional(),
});

export type NodeReading = z.infer<typeof nodeReadingSchema>;

/**
 * checkIn — a node reporting for duty, every DORMICE_CHECK_IN_INTERVAL_SECONDS
 * (15 by default), authenticated with the token the gateway and every node
 * share. The gateway learns of a node from its first check-in: there is no
 * registration verb and no nodes file — "which nodes exist" has one home,
 * the gateway's nodes table, written by the nodes themselves. Two missed
 * check-ins read as down: no new sandbox is placed there and its sandboxes
 * answer 502 until it reports again. Who knows the truth speaks: the node
 * knows what it runs and where it can be reached; the gateway only listens
 * and compares, and never keeps a record of what it told whom.
 */
export const checkInRequestSchema = z.object({
  /** DORMICE_NODE_ID — the node's name in every sandbox's `nodeId`. */
  nodeId: z.string().min(1),
  /** Where the gateway forwards to: the node's intranet front (DORMICE_NODE_ENDPOINT) — an origin, endpointSchema has why. */
  endpoint: endpointSchema,
  /** How often this node checks in — the gateway's yardstick for "missed two in a row". */
  intervalSeconds: z.number().int().positive(),
  build: buildInfoSchema.nullable(),
  reading: nodeReadingSchema,
  /**
   * The configuration version this node runs — its copy's
   * (nodeConfigBundleSchema); null while it holds no copy. The gateway
   * compares it with its own and answers the whole bundle when the two
   * differ: the check-in IS the pull, there is no second verb and nothing
   * the gateway has to remember about who was told what.
   */
  configVersion: z.number().int().nullable(),
  /**
   * Whether this node can upgrade itself when told (its updater's
   * availability: a git checkout, install.sh, systemd-run; upgrade.ts),
   * and why not when it cannot. The gateway rolls an upgrade only over
   * nodes that can; the rest it lists as `unavailable` with the reason.
   * Optional on the wire: a node on a build before the fourth cut does
   * not say, and its check-in is taken.
   */
  selfUpgrade: z
    .object({ available: z.boolean(), reason: z.string().nullable() })
    .optional(),
});

export type CheckInRequest = z.infer<typeof checkInRequestSchema>;

/**
 * The configuration a node runs, whole (design record #22: the gateway
 * holds the fleet's configuration, every node keeps a copy). The fleet
 * settings — the archive store WITH its keys, since the node must present
 * them to S3 verbatim; this bundle crosses only the gateway→node wire
 * under the fleet token and is never an observation answer — this node's
 * own row (its managed-swap target) and every template. Whole on purpose,
 * not a diff: the node applies it in one transaction and then holds
 * exactly what the gateway holds under that version, nothing to merge and
 * nothing to miss. It rides on the check-in response whenever the node's
 * version differs from the gateway's — a fresh node's null, a node that
 * missed an edit while its gateway was away, an operator's change a
 * second ago — and the node keeps it: a node whose gateway is down still
 * knows its settings and its templates, and serves.
 */
export const nodeConfigBundleSchema = z.object({
  version: z.number().int().positive(),
  settings: z.object({
    sandboxDefaults: sandboxResourceDefaultsSchema,
    defaultPolicy: lifecyclePolicySchema,
    /** Write shape, keys included — see above. Null = archiving off. */
    s3: s3ArchiveSettingsSchema.nullable(),
    sandboxDomain: z.string().regex(bareHostnameRegex).nullable(),
    sandboxDomainAliases: z.array(z.string().regex(bareHostnameRegex)),
    pidsLimit: z.number().int().min(PIDS_LIMIT_MIN),
    /**
     * The fleet's base image and its registry (settings.ts has both).
     * Default null, not required: a rolling upgrade takes the gateway
     * first, and a node on this build must take a bundle from a gateway
     * on the previous one — it then falls back to its own env for the
     * base image, said as a warning (server/node-config.ts).
     */
    baseImage: z.string().nullable().default(null),
    registryAddress: z.string().nullable().default(null),
  }),
  node: z.object({
    /** This node's managed-swap target, GiB (updateNodeSettings). */
    swapGb: z.number().int().nonnegative(),
  }),
  templates: z.array(templateSchema),
});

export type NodeConfigBundle = z.infer<typeof nodeConfigBundleSchema>;

export const checkInResponseSchema = z.object({
  /** The gateway's current configuration version — what the node reports back at its next check-in. */
  configVersion: z.number().int().positive(),
  /** Present exactly when the node's reported version differs from the gateway's: the whole bundle to apply. */
  config: nodeConfigBundleSchema.optional(),
  /**
   * Present exactly when the gateway tells this node to upgrade itself
   * now (upgrade.ts: the fleet upgrade rolls over the nodes one at a
   * time, each told once at a check-in) — the node runs its own
   * applyUpgrade and comes back on the gateway's build.
   */
  upgrade: z.literal(true).optional(),
});

export type CheckInResponse = z.infer<typeof checkInResponseSchema>;

/**
 * listNodes — every node the gateway has ever heard from, with what it
 * last said. Everything here is what the gateway already holds; answering
 * costs no node anything.
 */
export const listNodesRequestSchema = z.object({});

export const nodeViewSchema = z.object({
  id: z.string(),
  endpoint: z.string(),
  /** ISO 8601 UTC — the first check-in. */
  addedAt: z.iso.datetime(),
  /** The node's own setting: managed swap on its data disk, GiB (updateNodeSettings). */
  swapGb: z.number().int().nonnegative(),
  /** The configuration version the node last reported it runs; null until it has said (or before it pulls one). */
  configVersion: z.number().int().nullable(),
  /** ISO 8601 UTC — the last check-in taken, kept across gateway restarts; null only for a node that has never checked in. */
  lastCheckInAt: z.iso.datetime().nullable(),
  intervalSeconds: z.number().int().positive().nullable(),
  /** Checked in within two of its own intervals. */
  reachable: z.boolean(),
  build: buildInfoSchema.nullable(),
  reading: nodeReadingSchema.nullable(),
  /** Sandboxes the gateway placed here since the last check-in — counted against the node until the next reading shows them. */
  placedSinceCheckIn: z.number().int().nonnegative(),
});

export type NodeView = z.infer<typeof nodeViewSchema>;

export const listNodesResponseSchema = z.object({
  nodes: z.array(nodeViewSchema),
});

export type ListNodesResponse = z.infer<typeof listNodesResponseSchema>;

/**
 * removeNode — the operator's word that a node is gone for good: its row
 * goes, its sandboxes are no longer looked for, and a name that lived only
 * there is a new name again. A node that is merely down needs nothing —
 * it is back the moment it checks in — and one removed by mistake re-adds
 * itself the same way. Refused (409) while the node is still checking in:
 * a name of its acquired in the seconds before its next check-in would be
 * built elsewhere and come back on two nodes. Stop the daemon, wait two of
 * its intervals (that is "down"), then remove.
 */
export const removeNodeRequestSchema = z.object({
  id: z.string().min(1),
});

export type RemoveNodeRequest = z.infer<typeof removeNodeRequestSchema>;

export const removeNodeResponseSchema = z.object({
  /** True when a row existed and was removed; false when there was none. */
  removed: z.boolean(),
});

export type RemoveNodeResponse = z.infer<typeof removeNodeResponseSchema>;

/**
 * updateNodeSettings — the one per-node knob: how much swap the node's
 * daemon manages on its own data disk, on top of the host's own. A
 * machine's setting, not the fleet's (a 29 GB box and a 243 GB box want
 * different numbers), so it lives on the node's row and reaches that node
 * alone with the next configuration bundle. Growing takes effect at the
 * node within one check-in; shrinking waits for that host's next reboot —
 * an active swapfile is never unmounted (server/swap.ts has the rule).
 * Refused (400) for a node whose last reading says its daemon cannot
 * manage swap (a non-Linux host, the fake executor): a target nothing
 * will ever reconcile must refuse, not be stored. 404 for an unknown id.
 */
export const updateNodeSettingsRequestSchema = z.object({
  id: z.string().min(1),
  swapGb: z.number().int().nonnegative(),
});

export type UpdateNodeSettingsRequest = z.infer<
  typeof updateNodeSettingsRequestSchema
>;

export const updateNodeSettingsResponseSchema = z.object({
  node: nodeViewSchema,
});

export type UpdateNodeSettingsResponse = z.infer<
  typeof updateNodeSettingsResponseSchema
>;

/**
 * A node a merged answer could not include, and why. The gateway's
 * fleet-wide lists (listSandboxes, listSandboxMetrics, listSandboxImages)
 * ask every node and concatenate; a node that is down, not listening yet
 * or too slow is left out — and said, here, in the same answer. A list
 * that quietly lacked a node would pass for the whole fleet, and refusing
 * the whole list for one node would blind the operator exactly when a
 * node is in trouble (RULES: a verb tells the truth). Always present in a
 * gateway's answer, empty when every node answered; absent from a node's
 * own answer, which has nobody to be silent.
 */
export const silentNodeSchema = z.object({
  nodeId: z.string(),
  /** In the gateway's words: why the node was not asked (down, not listening yet) or how it failed to answer (the transport's word). */
  why: z.string(),
});

export type SilentNode = z.infer<typeof silentNodeSchema>;

/**
 * getFleetMetrics() — the fleet's figures that add up, from what the
 * gateway already holds: every node's last reading. The sandbox census by
 * state and the sandbox disks' bill are sums over nodes; a machine's CPU,
 * memory and swap are not, and getHostMetrics names a node for those.
 * Costs no node anything — the console polls this every few seconds, and
 * a poll that fanned out to every node would make the nodes' one observer
 * their heaviest caller (design record #24: the console's polling was 42%
 * of every request measured on the Beijing node, 2026-09-12).
 *
 * `nodes.reported` says how many nodes the sums cover: a node that has
 * never checked in (a row the import pre-created) has no reading here,
 * and until it does the sums are a lower bound — said as such, never
 * rounded up. A gateway restart loses no reading: each node's last one
 * is on its row.
 */
export const getFleetMetricsRequestSchema = z.object({});

export type GetFleetMetricsRequest = z.infer<
  typeof getFleetMetricsRequestSchema
>;

export const getFleetMetricsResponseSchema = z.object({
  nodes: z.object({
    /** Every node the gateway knows — its nodes table. */
    total: z.number().int(),
    /** Checked in within two of their own intervals (listNodes' `reachable`). */
    reachable: z.number().int(),
    /** Have a reading — have checked in at least once (a restart keeps it). The sums below cover exactly these. */
    reported: z.number().int(),
  }),
  sandboxes: z.object({
    total: z.number().int(),
    byState: sandboxStateCountsSchema,
  }),
  /** Summed over the reported nodes whose reading carries it (a node on an older build reports none). */
  sandboxDisks: sandboxDisksSchema,
});

export type GetFleetMetricsResponse = z.infer<
  typeof getFleetMetricsResponseSchema
>;

/**
 * getFleetStateHistory(start?, end?) — how many sandboxes sat in each
 * state over time, fleet-wide: the product's own story ("idle is free" is
 * visible as active falling while frozen rises). Answered by the gateway
 * from its fleet_state_samples — one row per tick of its own sampler
 * (DORMICE_GATEWAY_SAMPLE_INTERVAL_SECONDS, 30 by default), the sum of
 * every node's last census at that moment (design record #26: the one
 * figure no single node can compute); a node keeps no fleet history of
 * its own since the third cut. Kept 30 days.
 *
 * Bucketing differs from the per-sandbox verb on purpose: a bucket
 * reports its last raw row whole, never per-state maxima — independent
 * maxima would double-count a sandbox mid-transition and the stacked
 * counts would stop summing to total. The concurrency peak is instead
 * computed from the window's raw rows and carried separately in `peak`,
 * so no bucketing can flatten it.
 */
export const fleetStatePointSchema = z.object({
  /** ISO 8601 UTC — when the sample was taken. */
  at: z.string(),
  byState: sandboxStateCountsSchema,
  total: z.number().int(),
});

export type FleetStatePoint = z.infer<typeof fleetStatePointSchema>;

export const getFleetStateHistoryRequestSchema = z.object({
  /** ISO 8601; defaults to 24 hours before `end`. */
  start: isoTimestampSchema.optional(),
  /** ISO 8601; defaults to now. */
  end: isoTimestampSchema.optional(),
});

export type GetFleetStateHistoryRequest = z.infer<
  typeof getFleetStateHistoryRequestSchema
>;

export const getFleetStateHistoryResponseSchema = z.object({
  /** Ascending by timestamp. */
  points: z.array(fleetStatePointSchema),
  /** Null when raw samples were returned unbucketed. */
  bucketSeconds: z.number().int().positive().nullable(),
  /**
   * Highest active count in the window, from raw rows (not buckets), with
   * the earliest instant it was observed. Null when the window holds no
   * samples at all.
   */
  peak: z
    .object({
      active: z.number().int(),
      at: z.string(),
    })
    .nullable(),
});

export type GetFleetStateHistoryResponse = z.infer<
  typeof getFleetStateHistoryResponseSchema
>;

/**
 * The native verbs that answer at the gateway and nowhere else: the
 * fleet's configuration (keys, settings, templates, domains, nodes) and
 * its own observation (getFleetMetrics, getFleetStateHistory). A node has
 * no route for them, and its 404 names the gateway (server/app.ts); the
 * gateway's suite checks that each is registered — so the two ends of
 * this list cannot drift apart.
 */
export const GATEWAY_ONLY_VERBS = [
  'createApiKey',
  'listApiKeys',
  'updateApiKey',
  'revokeApiKey',
  'getConfig',
  'updateSettings',
  'registerTemplate',
  'listTemplates',
  'removeTemplate',
  'getIngress',
  'setIngress',
  'listNodes',
  'updateNodeSettings',
  'removeNode',
  'getFleetMetrics',
  'getFleetStateHistory',
] as const;

export type GatewayOnlyVerb = (typeof GATEWAY_ONLY_VERBS)[number];
