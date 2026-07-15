import { z } from 'zod';

/**
 * getHostMetrics() — the observation window into the machine itself: is the
 * host healthy, and what do the sandboxes collectively cost it? A single
 * point-in-time snapshot: host-level trends (CPU, memory, disk) remain a
 * monitoring system's job — point Prometheus at the box. What the daemon
 * does keep is its own domain history — per-sandbox samples and fleet state
 * counts (getFleetTimeline in metrics.ts), which no external monitor can
 * reconstruct from outside the ledger. Observation never wakes a sandbox
 * and never touches lifecycle.
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
