import {
  checkInRequestSchema,
  checkInResponseSchema,
  listNodesRequestSchema,
  listNodesResponseSchema,
  removeNodeRequestSchema,
  removeNodeResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { NameCache } from '../cache';
import { downReason, type Fleet, STARTUP_GRACE_MS } from '../fleet';

export interface CheckInRoutesOptions {
  fleet: Fleet;
}

export interface NodeRoutesOptions {
  fleet: Fleet;
  cache: NameCache;
}

/** A refusal in the native dialect, rendered by the app's error handler as `{ message }` under its status. */
function refusal(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * The check-in the nodes send (RULES/协议.md「网关」) — behind the nodes'
 * own gate in app.ts: the fleet token and nothing else.
 */
export const checkInRoutes: FastifyPluginAsyncZod<
  CheckInRoutesOptions
> = async (app, { fleet }) => {
  /**
   * Per node, the ids it was last reported to share an endpoint with
   * (sorted, joined) — so the warning below is said when the situation
   * arises or changes, not at every check-in: two nodes on one endpoint
   * checking in every fifteen seconds is one misconfiguration, not two
   * hundred and forty log lines an hour (the daemon's check-in log keeps
   * the same discipline, server/check-in.ts).
   */
  const twinsWarned = new Map<string, string>();

  app.post(
    '/checkIn',
    {
      schema: {
        body: checkInRequestSchema,
        response: { 200: checkInResponseSchema },
      },
    },
    async (request) => {
      const outcome = fleet.checkIn(request.body);
      if ('refused' in outcome) {
        request.log.warn(
          { nodeId: request.body.nodeId, endpoint: request.body.endpoint },
          outcome.refused,
        );
        throw refusal(409, outcome.refused);
      }
      const { node, joined, movedFrom } = outcome;
      if (joined) {
        request.log.info(
          { nodeId: node.id, endpoint: node.endpoint },
          'a node checked in for the first time and joined the fleet',
        );
      }
      // Two misconfigurations show only here, so they are said here. A
      // node whose endpoint moves at every check-in is two machines
      // sharing one DORMICE_NODE_ID (the daemon's default is `node-1`).
      // Two nodes reporting one endpoint is a DORMICE_NODE_ENDPOINT that
      // names the wrong machine — the daemon refuses the loopback default
      // when its gateway is remote, but a hand-written value still can.
      // Either way the symptom downstream is a 409 on every name (both
      // "nodes" answer the lookup) or sandboxes on the wrong machine.
      if (movedFrom !== null) {
        request.log.warn(
          { nodeId: node.id, from: movedFrom, to: node.endpoint },
          'a node checked in from a new endpoint; the gateway forwards there from now on',
        );
      }
      const twins = fleet
        .all()
        .filter((n) => n.id !== node.id && n.endpoint === node.endpoint)
        .map((n) => n.id)
        .sort();
      const before = twinsWarned.get(node.id);
      if (twins.length > 0) {
        const now = twins.join(',');
        if (now !== before) {
          twinsWarned.set(node.id, now);
          request.log.warn(
            { nodeId: node.id, endpoint: node.endpoint, alsoReportedBy: twins },
            'two nodes report the same endpoint — check DORMICE_NODE_ID and DORMICE_NODE_ENDPOINT on both; their sandboxes will be found twice (409) or land on the wrong machine',
          );
        }
      } else if (before !== undefined) {
        twinsWarned.delete(node.id);
        request.log.info(
          { nodeId: node.id, endpoint: node.endpoint },
          'the node no longer shares its endpoint with another',
        );
      }
      return {};
    },
  );
};

/**
 * What an operator reads and does about the nodes — behind the admin gate.
 * Everything listNodes answers is what the gateway already holds, so
 * answering costs no node anything.
 */
export const nodeRoutes: FastifyPluginAsyncZod<NodeRoutesOptions> = async (
  app,
  { fleet, cache },
) => {
  app.post(
    '/listNodes',
    {
      schema: {
        body: listNodesRequestSchema,
        response: { 200: listNodesResponseSchema },
      },
    },
    async () => {
      const now = new Date();
      return {
        nodes: fleet.all().map((node) => ({
          id: node.id,
          endpoint: node.endpoint,
          addedAt: node.addedAt,
          lastCheckInAt: node.lastCheckInAt?.toISOString() ?? null,
          intervalSeconds: node.intervalSeconds,
          reachable: downReason(node, now) === null,
          build: node.build,
          reading: node.reading,
          placedSinceCheckIn: node.placedSinceCheckIn,
        })),
      };
    },
  );

  app.post(
    '/removeNode',
    {
      schema: {
        body: removeNodeRequestSchema,
        response: { 200: removeNodeResponseSchema },
      },
    },
    async (request) => {
      // "Gone for good" is refused for a node that is still checking in:
      // its row would go, its names would be new names, and any of them
      // acquired in the seconds before its next check-in would be built
      // elsewhere — then the node re-adds itself and every such name is on
      // two nodes, a 409 an operator clears by hand. Stop the daemon
      // first; two of its intervals of silence is what "down" means
      // (fleet.ts downReason), and a down node is removable (found by
      // review, 2026-09-14).
      const node = fleet.get(request.body.id);
      if (node !== undefined) {
        const now = new Date();
        // Right after a gateway start every node is silent so far, the
        // running ones included: they are heard from within one interval.
        // Until two default intervals have passed, "not heard from" is
        // not "down" (fleet.ts STARTUP_GRACE_MS).
        const sinceStart = now.getTime() - fleet.startedAt.getTime();
        if (node.lastCheckInAt === null && sinceStart < STARTUP_GRACE_MS) {
          throw refusal(
            409,
            `the gateway started ${Math.round(sinceStart / 1000)}s ago and has not heard from node ${node.id} yet — a running node checks in within its interval, so silence this early proves nothing; wait ${STARTUP_GRACE_MS / 1000}s from the gateway's start, then remove it`,
          );
        }
        if (downReason(node, now) === null && node.lastCheckInAt !== null) {
          const ago = Math.round(
            (now.getTime() - node.lastCheckInAt.getTime()) / 1000,
          );
          throw refusal(
            409,
            `node ${node.id} checked in ${ago}s ago — it is running, and its names would be placed elsewhere before it checked in again and come back as a 409 on two nodes; stop its daemon, wait two of its intervals (${node.intervalSeconds}s each), then remove it`,
          );
        }
      }
      const removed = fleet.remove(request.body.id);
      const evicted = cache.evictNode(request.body.id);
      if (removed) {
        request.log.warn(
          { nodeId: request.body.id, evicted },
          'a node was removed by an operator: its sandboxes are no longer looked for, and names that lived only there are new names again',
        );
      }
      return { removed };
    },
  );
};
