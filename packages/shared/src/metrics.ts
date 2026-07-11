import { z } from 'zod';
import { userKeySchema } from './sandbox';

/**
 * getSandboxMetrics(userKey) — one sandbox's point-in-time resource
 * reading: the per-sandbox sibling of getHostMetrics, and the native twin
 * of the E2B surface's metrics endpoint (same executor reading, same
 * single-sample answer — the daemon keeps no metrics history). Observation
 * never wakes a sandbox: a frozen sandbox is measured as it sleeps, and a
 * sandbox with no running container answers null instead of being started
 * just to be looked at.
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
  userKey: userKeySchema,
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
