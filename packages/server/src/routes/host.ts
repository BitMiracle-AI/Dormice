import os from 'node:os';
import {
  getFleetTimelineRequestSchema,
  getFleetTimelineResponseSchema,
  hostMetricsResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Config } from '../config';
import type { Db } from '../db/db';
import { countByState, listSandboxes } from '../db/ledger';
import {
  bucketSnapshots,
  queryFleetPeak,
  queryFleetSnapshots,
  resolveBucketSeconds,
  resolveWindow,
} from '../db/metrics';
import { readRuntimeSettings } from '../db/settings';
import type { Executor } from '../executor/executor';
import { CpuSampler, readDiskSpace, readHostMemory } from '../host-metrics';

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
 * keeps listing and metrics from waking anything).
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

      const memory = await readHostMemory();
      const dataDisk = await readDiskSpace(config.DORMICE_DATA_DIR);
      return {
        host: {
          cpuCount: os.cpus().length,
          cpuUsedPct: cpu.sample(),
          ...memory,
        },
        dataDisk: dataDisk
          ? { path: config.DORMICE_DATA_DIR, ...dataDisk }
          : null,
        sandboxes: {
          total,
          // The ledger's live knob, not the env seed — the console edits it.
          maxSandboxes: readRuntimeSettings(db).maxSandboxes,
          byState,
        },
        sandboxDisks: await executor.diskUsage(),
      };
    },
  );

  // The fleet's past: state counts per sampler tick, sliced and (past 360
  // points) bucketed. Buckets carry whole raw snapshots — the last one in
  // the bucket — so byState always sums to total; the concurrency peak is
  // computed from raw rows and travels beside the points, immune to
  // bucketing. A window the daemon slept through simply has no rows: the
  // gap IS the answer.
  app.post(
    '/getFleetTimeline',
    {
      schema: {
        body: getFleetTimelineRequestSchema,
        response: { 200: getFleetTimelineResponseSchema },
      },
    },
    async (request) => {
      const { startIso, endIso, startMs, endMs } = resolveWindow(
        request.body.start,
        request.body.end,
        24 * 3600_000,
        new Date(),
      );
      const rows = queryFleetSnapshots(db, startIso, endIso);
      const bucketSeconds = resolveBucketSeconds(rows.length, startMs, endMs);
      const points =
        bucketSeconds === null
          ? rows
          : bucketSnapshots(rows, startMs, bucketSeconds);
      return {
        points: points.map((row) => ({
          at: row.at,
          byState: {
            active: row.active,
            frozen: row.frozen,
            stopped: row.stopped,
            archived: row.archived,
            restoring: row.restoring,
          },
          total: row.total,
        })),
        bucketSeconds,
        peak: queryFleetPeak(db, startIso, endIso),
      };
    },
  );
};
