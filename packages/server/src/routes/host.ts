import {
  getHostMetricsHistoryRequestSchema,
  getHostMetricsHistoryResponseSchema,
  hostMetricsResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Config } from '../config';
import type { Db } from '../db/db';
import { countByState, listSandboxes } from '../db/ledger';
import {
  bucketHostSamples,
  queryHostCpuPeak,
  queryHostSamples,
} from '../db/metrics';
import type { Executor } from '../executor/executor';
import { resolveBucketSeconds, resolveWindow } from '../history';
import { CpuSampler, readHostReading } from '../host-metrics';

export interface HostRoutesOptions {
  config: Config;
  db: Db;
  executor: Executor;
}

/**
 * The observation window into the machine itself — the host-level sibling
 * of listSandboxes. Read-only by construction: it reads the ledger, /proc,
 * statfs and the disk images' metadata, and touches no sandbox and no
 * lifecycle state (observation is not activity — the same principle that
 * keeps listing and metrics from waking anything). A request may carry
 * `nodeId` (shared getHostMetricsRequestSchema): that is the gateway's
 * address of this node, forwarded along, and means nothing here.
 */
export const hostRoutes: FastifyPluginAsyncZod<HostRoutesOptions> = async (
  app,
  { config, db, executor },
) => {
  // One sampler per app: CPU usage is a delta between two samples, so it
  // spans "since the previous request". Primed at build time so the first
  // request usually has an interval to report on already.
  const cpu = new CpuSampler();
  cpu.sample();

  app.post(
    '/getHostMetrics',
    {
      schema: {
        response: { 200: hostMetricsResponseSchema },
      },
    },
    async () => {
      const rows = listSandboxes(db);
      const { byState, total } = countByState(rows);

      return {
        ...(await readHostReading(cpu, config.DORMICE_DATA_DIR)),
        sandboxes: {
          total,
          byState,
        },
        sandboxDisks: await executor.diskUsage(),
      };
    },
  );

  // The machine's past: one host reading per sampler tick, sliced and
  // (past 360 points) bucketed by per-field worst case — max for usage,
  // min for the "available" fields. The CPU peak travels beside the points
  // from raw rows, immune to bucketing. Nulls are platform gaps (no swap,
  // no data dir, no delta on the first tick), and a window the daemon
  // slept through has no rows: the gap IS the answer.
  app.post(
    '/getHostMetricsHistory',
    {
      schema: {
        body: getHostMetricsHistoryRequestSchema,
        response: { 200: getHostMetricsHistoryResponseSchema },
      },
    },
    async (request) => {
      const { startIso, endIso, startMs, endMs } = resolveWindow(
        request.body.start,
        request.body.end,
        24 * 3600_000,
        new Date(),
      );
      const rows = queryHostSamples(db, startIso, endIso);
      const bucketSeconds = resolveBucketSeconds(rows.length, startMs, endMs);
      const points =
        bucketSeconds === null
          ? rows
          : bucketHostSamples(rows, startMs, bucketSeconds);
      return {
        points: points.map((row) => ({
          at: row.at,
          cpuUsedPct: row.cpuUsedPct,
          memTotalBytes: row.memTotalBytes,
          memAvailableBytes: row.memAvailableBytes,
          swap:
            row.swapTotalBytes !== null && row.swapUsedBytes !== null
              ? {
                  totalBytes: row.swapTotalBytes,
                  usedBytes: row.swapUsedBytes,
                }
              : null,
          dataDisk:
            row.diskTotalBytes !== null &&
            row.diskUsedBytes !== null &&
            row.diskAvailableBytes !== null
              ? {
                  totalBytes: row.diskTotalBytes,
                  usedBytes: row.diskUsedBytes,
                  availableBytes: row.diskAvailableBytes,
                }
              : null,
        })),
        bucketSeconds,
        peak: queryHostCpuPeak(db, startIso, endIso),
      };
    },
  );
};
