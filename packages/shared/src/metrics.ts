import { z } from 'zod';
import { sandboxNameSchema } from './sandbox';

/**
 * getSandboxMetrics(name) — one sandbox's point-in-time resource
 * reading: the per-sandbox sibling of getHostMetrics, and the native twin
 * of the E2B surface's metrics endpoint (same executor reading). For the
 * past instead of the present, getSandboxMetricsHistory below serves the
 * daemon's sampled history. Observation never wakes a sandbox: a frozen
 * sandbox is measured as it sleeps, and a sandbox with no running container
 * answers null instead of being started just to be looked at.
 */
export const sandboxMetricsSampleSchema = z.object({
  /** ISO 8601 UTC — when the reading was taken. */
  timestamp: z.string(),
  /** Configured CPU allowance. */
  cpuCount: z.number(),
  /** Percent of one CPU; can exceed 100 on a multi-CPU sandbox. */
  cpuUsedPct: z.number(),
  memUsedBytes: z.number(),
  memTotalBytes: z.number(),
  memCacheBytes: z.number(),
  diskUsedBytes: z.number(),
  diskTotalBytes: z.number(),
});

export type SandboxMetricsSample = z.infer<typeof sandboxMetricsSampleSchema>;

export const getSandboxMetricsRequestSchema = z.object({
  name: sandboxNameSchema,
});

export type GetSandboxMetricsRequest = z.infer<
  typeof getSandboxMetricsRequestSchema
>;

export const getSandboxMetricsResponseSchema = z.object({
  /** Null when nothing is running to measure (stopped, archived, restoring). */
  sample: sandboxMetricsSampleSchema.nullable(),
});

export type GetSandboxMetricsResponse = z.infer<
  typeof getSandboxMetricsResponseSchema
>;

/**
 * listSandboxMetrics() — every measurable sandbox in one answer, so a list
 * view showing N sandboxes costs one request instead of N. Presence means
 * measured: only physically running/paused sandboxes appear (the same
 * honesty as getSandboxMetrics's null, expressed as absence), and a
 * container that vanishes mid-reading is skipped rather than invented.
 */
export const listSandboxMetricsRequestSchema = z.object({});

export type ListSandboxMetricsRequest = z.infer<
  typeof listSandboxMetricsRequestSchema
>;

export const listSandboxMetricsResponseSchema = z.object({
  samples: z.array(
    // References from outside the sandbox object carry the entity's name:
    // a bare `name`/`id` here would read as the row's own identity.
    z.object({
      sandboxName: z.string(),
      sandboxId: z.string(),
      sample: sandboxMetricsSampleSchema,
    }),
  ),
});

export type ListSandboxMetricsResponse = z.infer<
  typeof listSandboxMetricsResponseSchema
>;

/**
 * getSandboxMetricsHistory(name, start?, end?) — the sampled past of
 * one sandbox. The daemon's background sampler persists a reading per
 * measurable sandbox every DORMICE_METRICS_SAMPLE_INTERVAL_SECONDS; this
 * verb slices that history. History exists because it is a compatibility
 * contract (the E2B metrics endpoint takes start/end) and because no
 * external monitor can measure per-sandbox from outside the ledger —
 * host-level trends still belong to Prometheus.
 *
 * Wire honesty rules:
 * - start/end are ISO 8601 (unix seconds are the E2B surface's dialect,
 *   translated at that boundary). Defaults: end = now, start = end - 1h.
 * - The window's raw rows are returned as-is up to 360 points; past that
 *   the server buckets them (bucketSeconds says how wide) and each bucket
 *   reports its per-field max — a caller reading history is hunting for
 *   spikes, and averaging would erase exactly what they came for.
 * - Gaps are real: a daemon that was down sampled nothing, and the answer
 *   shows the hole instead of interpolating over it.
 * - An unsampled sandbox answers an empty array — never a made-up reading.
 */
/**
 * A parseable timestamp, rejected at the door: a malformed start/end would
 * otherwise turn into NaN arithmetic deep in the window resolver.
 */
const isoTimestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'must be an ISO 8601 timestamp',
  });

export const getSandboxMetricsHistoryRequestSchema = z.object({
  name: sandboxNameSchema,
  /** ISO 8601; defaults to one hour before `end`. */
  start: isoTimestampSchema.optional(),
  /** ISO 8601; defaults to now. */
  end: isoTimestampSchema.optional(),
});

export type GetSandboxMetricsHistoryRequest = z.infer<
  typeof getSandboxMetricsHistoryRequestSchema
>;

export const getSandboxMetricsHistoryResponseSchema = z.object({
  /** Ascending by timestamp. */
  samples: z.array(sandboxMetricsSampleSchema),
  /** Null when raw samples were returned unbucketed. */
  bucketSeconds: z.number().int().positive().nullable(),
});

export type GetSandboxMetricsHistoryResponse = z.infer<
  typeof getSandboxMetricsHistoryResponseSchema
>;

/**
 * getFleetTimeline(start?, end?) — how many sandboxes sat in each state
 * over time: the fleet-level sibling of getSandboxMetricsHistory, and the
 * product's own story ("idle is free" is visible as active falling while
 * frozen rises). One snapshot row per sampler tick, kept 30 days.
 *
 * Bucketing differs from the per-sandbox verb on purpose: a bucket reports
 * its last raw snapshot whole, never per-state maxima — independent maxima
 * would double-count a sandbox mid-transition and the stacked counts would
 * stop summing to total. The concurrency peak is instead computed from the
 * window's raw rows and carried separately in `peak`, so no bucketing can
 * flatten it.
 */
export const fleetTimelinePointSchema = z.object({
  /** ISO 8601 UTC — when the snapshot was taken. */
  at: z.string(),
  byState: z.object({
    active: z.number().int(),
    frozen: z.number().int(),
    stopped: z.number().int(),
    archived: z.number().int(),
    restoring: z.number().int(),
  }),
  total: z.number().int(),
});

export type FleetTimelinePoint = z.infer<typeof fleetTimelinePointSchema>;

export const getFleetTimelineRequestSchema = z.object({
  /** ISO 8601; defaults to 24 hours before `end`. */
  start: isoTimestampSchema.optional(),
  /** ISO 8601; defaults to now. */
  end: isoTimestampSchema.optional(),
});

export type GetFleetTimelineRequest = z.infer<
  typeof getFleetTimelineRequestSchema
>;

export const getFleetTimelineResponseSchema = z.object({
  /** Ascending by timestamp. */
  points: z.array(fleetTimelinePointSchema),
  /** Null when raw snapshots were returned unbucketed. */
  bucketSeconds: z.number().int().positive().nullable(),
  /**
   * Highest active count in the window, from raw rows (not buckets), with
   * the earliest instant it was observed. Null when the window holds no
   * snapshots at all.
   */
  peak: z
    .object({
      active: z.number().int(),
      at: z.string(),
    })
    .nullable(),
});

export type GetFleetTimelineResponse = z.infer<
  typeof getFleetTimelineResponseSchema
>;
