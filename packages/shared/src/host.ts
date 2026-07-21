import { z } from 'zod';

/**
 * getHostMetrics() — the observation window into the machine itself: is the
 * host healthy, and what do the sandboxes collectively cost it? A single
 * point-in-time snapshot; for the machine's past see getHostMetricsHistory
 * below. Observation never wakes a sandbox and never touches lifecycle.
 *
 * Readings a platform cannot produce are null, honestly — never zero, never
 * invented: swap and /proc are Linux facts, and the data directory only
 * exists where the docker executor runs.
 */
export const hostMetricsResponseSchema = z.object({
  host: z.object({
    cpuCount: z.number().int().positive(),
    /**
     * Percent of the whole machine, 0-100. Null until the sampler has two
     * samples to take a delta between — the first request after daemon
     * start reports "don't know yet", not a made-up 0.
     */
    cpuUsedPct: z.number().nullable(),
    memTotalBytes: z.number(),
    /**
     * What could still be allocated without swapping — /proc/meminfo's
     * MemAvailable (counts reclaimable page cache), not the naive "free".
     */
    memAvailableBytes: z.number(),
    /**
     * Swap is the freeze mechanism's fuel: frozen sandboxes live there, and
     * a full swap means "idle is free" stops being true. totalBytes of 0 is
     * an honest reading of a machine with no swap configured (doctor warns
     * about it); null means the platform offers no reading at all.
     */
    swap: z
      .object({
        totalBytes: z.number(),
        usedBytes: z.number(),
      })
      .nullable(),
  }),
  /**
   * The filesystem holding DORMICE_DATA_DIR — where sandbox disks live. A
   * full data disk is the real capacity ceiling (past it, even the ledger
   * cannot write). Null when the directory does not exist (fake executor,
   * fresh install).
   */
  dataDisk: z
    .object({
      path: z.string(),
      totalBytes: z.number(),
      usedBytes: z.number(),
      availableBytes: z.number(),
    })
    .nullable(),
  /** Ledger aggregates: what the daemon believes it is running. */
  sandboxes: z.object({
    total: z.number().int(),
    maxSandboxes: z.number().int(),
    byState: z.object({
      active: z.number().int(),
      frozen: z.number().int(),
      stopped: z.number().int(),
      archived: z.number().int(),
      restoring: z.number().int(),
    }),
  }),
  /**
   * What the sandbox disks cost, from the executor: nominal is the summed
   * promised sizes, actual is what the sparse images really occupy. The gap
   * is the overcommit — the number an operator watches close as the host
   * fills, because nothing else caps it.
   */
  sandboxDisks: z.object({
    count: z.number().int(),
    nominalBytes: z.number(),
    actualBytes: z.number(),
  }),
});

export type HostMetricsResponse = z.infer<typeof hostMetricsResponseSchema>;

/**
 * getHostMetricsHistory(start?, end?) — the machine's sampled past: the
 * host-level sibling of getSandboxMetricsHistory, written by the same
 * background sampler tick and kept a fixed 30 days. This verb exists
 * because the original "host trends belong to Prometheus" ruling was
 * overturned (2026-07-21): on a self-hosted single box nobody runs
 * Prometheus, and the platform's own capacity story — overcommit by
 * observation — needs a CPU peak to observe.
 *
 * Wire honesty follows the sibling verbs:
 * - start/end are ISO 8601. Defaults: end = now, start = end - 24h (the
 *   fleet timeline's window, not the per-sandbox verb's 1h — both feed the
 *   same dashboard).
 * - Raw rows up to 360 points, bucketed past that (bucketSeconds says how
 *   wide). Buckets keep a per-field envelope of the WORST case: max for
 *   usage fields, min for the "available" fields — a memory-pressure spike
 *   is a low point of MemAvailable, and averaging (or a max) would erase
 *   exactly what the reader came for. Bucket timestamps are synthetic
 *   (the bucket's start).
 * - The window's CPU peak is computed from raw rows and travels beside the
 *   points, immune to bucketing. Null when the window holds no CPU reading.
 * - Gaps are real: a daemon that was down sampled nothing. Nulls inside a
 *   point are platform gaps (no swap on this box, no data dir yet, no CPU
 *   delta on the first tick after a start), never zeros.
 */
export const hostTimelinePointSchema = z.object({
  /** ISO 8601 UTC — sample time, or the bucket's start once bucketed. */
  at: z.string(),
  /** Percent of the whole machine, 0-100. */
  cpuUsedPct: z.number().nullable(),
  memTotalBytes: z.number(),
  memAvailableBytes: z.number(),
  swap: z
    .object({
      totalBytes: z.number(),
      usedBytes: z.number(),
    })
    .nullable(),
  dataDisk: z
    .object({
      totalBytes: z.number(),
      usedBytes: z.number(),
      availableBytes: z.number(),
    })
    .nullable(),
});

export type HostTimelinePoint = z.infer<typeof hostTimelinePointSchema>;

/**
 * A parseable timestamp, rejected at the door — same rule as the metrics
 * verbs: a malformed start/end must 400, never become NaN arithmetic.
 */
const isoTimestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'must be an ISO 8601 timestamp',
  });

export const getHostMetricsHistoryRequestSchema = z.object({
  /** ISO 8601; defaults to 24 hours before `end`. */
  start: isoTimestampSchema.optional(),
  /** ISO 8601; defaults to now. */
  end: isoTimestampSchema.optional(),
});

export type GetHostMetricsHistoryRequest = z.infer<
  typeof getHostMetricsHistoryRequestSchema
>;

export const getHostMetricsHistoryResponseSchema = z.object({
  /** Ascending by timestamp. */
  points: z.array(hostTimelinePointSchema),
  /** Null when raw samples were returned unbucketed. */
  bucketSeconds: z.number().int().positive().nullable(),
  /**
   * Highest whole-machine CPU percentage in the window, from raw rows (not
   * buckets), with the earliest instant it was observed. Null when the
   * window holds no CPU reading at all.
   */
  peak: z
    .object({
      cpuUsedPct: z.number(),
      at: z.string(),
    })
    .nullable(),
});

export type GetHostMetricsHistoryResponse = z.infer<
  typeof getHostMetricsHistoryResponseSchema
>;
