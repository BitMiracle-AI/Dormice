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
import { downReason, type Fleet } from '../fleet';

export interface NodeRoutesOptions {
  fleet: Fleet;
  cache: NameCache;
}

/**
 * The gateway's own verbs about its nodes: the check-in the nodes send
 * (RULES/协议.md「网关」), and what an operator reads and does about them.
 * Everything listNodes answers is what the gateway already holds, so
 * answering costs no node anything.
 */
export const nodeRoutes: FastifyPluginAsyncZod<NodeRoutesOptions> = async (
  app,
  { fleet, cache },
) => {
  app.post(
    '/checkIn',
    {
      schema: {
        body: checkInRequestSchema,
        response: { 200: checkInResponseSchema },
      },
    },
    async (request) => {
      const { node, joined, movedFrom } = fleet.checkIn(request.body);
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
        .filter((n) => n.id !== node.id && n.endpoint === node.endpoint);
      if (twins.length > 0) {
        request.log.warn(
          {
            nodeId: node.id,
            endpoint: node.endpoint,
            alsoReportedBy: twins.map((n) => n.id),
          },
          'two nodes report the same endpoint — check DORMICE_NODE_ID and DORMICE_NODE_ENDPOINT on both; their sandboxes will be found twice (409) or land on the wrong machine',
        );
      }
      return {};
    },
  );

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
