import os from 'node:os';
import { hostMetricsResponseSchema, SANDBOX_STATES } from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Config } from '../config';
import type { Db } from '../db/db';
import { listSandboxes } from '../db/ledger';
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
      const byState = Object.fromEntries(
        SANDBOX_STATES.map((state) => [state, 0]),
      ) as Record<(typeof SANDBOX_STATES)[number], number>;
      for (const row of rows) byState[row.state] += 1;

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
          total: rows.length,
          maxSandboxes: config.DORMICE_MAX_SANDBOXES,
          byState,
        },
        sandboxDisks: await executor.diskUsage(),
      };
    },
  );
};
