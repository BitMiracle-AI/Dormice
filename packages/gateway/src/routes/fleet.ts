import {
  bucketLast,
  resolveBucketSeconds,
  resolveWindow,
} from '@dormice/server/history';
import {
  getFleetMetricsRequestSchema,
  getFleetMetricsResponseSchema,
  getFleetStateHistoryRequestSchema,
  getFleetStateHistoryResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../db/db';
import { queryFleetPeak, queryFleetSamples } from '../db/fleet-samples';
import { downReason, type Fleet, sumReadings } from '../fleet';

export interface FleetRoutesOptions {
  db: Db;
  fleet: Fleet;
}

/**
 * The fleet's own observation: the figures that add up, answered from
 * what the gateway already holds and never by asking a node (design
 * record #24 — the console polls these every few seconds, and a poll
 * that fanned out would make the fleet's one observer its heaviest
 * caller). getFleetMetrics is the present, from every node's last
 * reading; getFleetStateHistory is the past, from the rows the gateway's
 * own sampler wrote (db/fleet-samples.ts). Behind the sandbox gate, as
 * observation is on a node.
 */
export const fleetRoutes: FastifyPluginAsyncZod<FleetRoutesOptions> = async (
  app,
  { db, fleet },
) => {
  app.post(
    '/getFleetMetrics',
    {
      schema: {
        body: getFleetMetricsRequestSchema,
        response: { 200: getFleetMetricsResponseSchema },
      },
    },
    async () => {
      const now = new Date();
      const nodes = fleet.all();
      const { reported, sandboxes, sandboxDisks } = sumReadings(nodes);
      return {
        nodes: {
          total: nodes.length,
          reachable: nodes.filter((node) => downReason(node, now) === null)
            .length,
          reported,
        },
        sandboxes,
        sandboxDisks,
      };
    },
  );

  // The fleet's past: state counts per sampler tick, sliced and (past 360
  // points) bucketed. Buckets carry whole raw samples — the last one in
  // the bucket — so byState always sums to total; the concurrency peak is
  // computed from raw rows and travels beside the points, immune to
  // bucketing. A window the gateway was down for has no rows: the gap IS
  // the answer.
  app.post(
    '/getFleetStateHistory',
    {
      schema: {
        body: getFleetStateHistoryRequestSchema,
        response: { 200: getFleetStateHistoryResponseSchema },
      },
    },
    async (request) => {
      const { startIso, endIso, startMs, endMs } = resolveWindow(
        request.body.start,
        request.body.end,
        24 * 3600_000,
        new Date(),
      );
      const rows = queryFleetSamples(db, startIso, endIso);
      const bucketSeconds = resolveBucketSeconds(rows.length, startMs, endMs);
      const points =
        bucketSeconds === null
          ? rows
          : bucketLast(rows, startMs, bucketSeconds);
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
