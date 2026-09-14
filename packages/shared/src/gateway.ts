import { z } from 'zod';
import {
  dataDiskSchema,
  hostReadingSchema,
  sandboxStateCountsSchema,
} from './host';

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
});

export type CheckInRequest = z.infer<typeof checkInRequestSchema>;

/** Nothing yet: the configuration version the gateway will answer with arrives with the configuration authority. */
export const checkInResponseSchema = z.object({});

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
  /** ISO 8601 UTC — null only right after a gateway start, before the node's next check-in. */
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
