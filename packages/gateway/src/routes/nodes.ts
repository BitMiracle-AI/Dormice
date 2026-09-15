import {
  checkInRequestSchema,
  checkInResponseSchema,
  listNodesRequestSchema,
  listNodesResponseSchema,
  type NodeView,
  removeNodeRequestSchema,
  removeNodeResponseSchema,
  updateNodeSettingsRequestSchema,
  updateNodeSettingsResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { NameCache } from '../cache';
import type { Db } from '../db/db';
import { readNodeConfig } from '../db/node-config';
import { readConfigVersion } from '../db/settings';
import { downReason, type Fleet, type NodeState } from '../fleet';
import { RETRY_AFTER_SECONDS } from '../raw';
import type { Rolling } from '../rolling';

export interface CheckInRoutesOptions {
  fleet: Fleet;
  db: Db;
  /** The fleet upgrade's verdict for each check-in (rolling.ts). */
  rolling: Rolling;
}

export interface NodeRoutesOptions {
  fleet: Fleet;
  cache: NameCache;
  /** Forgets a removed node's pending re-tell (rolling.ts forget). */
  rolling: Rolling;
}

/** A refusal in the native dialect, rendered by the app's error handler as `{ message }` under its status. */
function refusal(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * The check-in the nodes send (RULES/协议.md「网关」) — behind the nodes'
 * own gate in app.ts: the fleet token and nothing else. The answer is the
 * configuration version, and the whole bundle when the node's differs
 * (design record #22, shared nodeConfigBundleSchema): the check-in is the
 * pull. Of the configuration no record is kept of who was told what —
 * the node states what it runs at every check-in, and the comparison is
 * the whole protocol. The fleet upgrade rides the same answer (`upgrade:
 * true`, rolling.ts) and is the one thing remembered: a node is told
 * once, on its row.
 */
export const checkInRoutes: FastifyPluginAsyncZod<
  CheckInRoutesOptions
> = async (app, { fleet, db, rolling }) => {
  /**
   * Per node, the ids it was last reported to share an endpoint with
   * (sorted, joined) — so the warning below is said when the situation
   * arises or changes, not at every check-in: two nodes on one endpoint
   * checking in every fifteen seconds is one misconfiguration, not two
   * hundred and forty log lines an hour (the daemon's check-in log keeps
   * the same discipline, server/check-in.ts).
   */
  const twinsWarned = new Map<string, string>();
  /**
   * Per node, the gap (version it runs → version current) the bundle was
   * last said to ride on — so the line below is said when a node falls
   * behind or the gap changes, not at every check-in: a node that cannot
   * apply a bundle reports the old version every fifteen seconds and is
   * answered the bundle every time (the retry is the protocol,
   * server/check-in.ts) — one situation, not two hundred and forty lines
   * an hour (left by the second cut's review, 2026-09-14). Catching up is
   * said once too: it is the edit's arrival at that node.
   */
  const bundleSaid = new Map<string, string>();

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
      // The fleet upgrade's turn for this node, if it is its turn: said
      // here, once — the tell is the event, and the node's own log has the
      // run.
      const told = rolling.onCheckIn(node, new Date());
      if (told) {
        request.log.info(
          { nodeId: node.id, build: node.build?.commit ?? null },
          'the node is told to upgrade itself: it runs another build than the gateway and no other node is upgrading',
        );
      }
      const upgrade = told ? { upgrade: true as const } : {};
      const version = readConfigVersion(db);
      const runs = request.body.configVersion;
      if (runs === version) {
        if (bundleSaid.delete(node.id)) {
          request.log.info(
            { nodeId: node.id, version },
            'the node now runs the current configuration version',
          );
        }
        return { configVersion: version, ...upgrade };
      }
      const gap = `${String(runs)}→${version}`;
      if (bundleSaid.get(node.id) !== gap) {
        bundleSaid.set(node.id, gap);
        request.log.info(
          { nodeId: node.id, runs, current: version },
          runs === null
            ? 'a node with no configuration copy checked in; the bundle rides on this answer'
            : 'a node runs another configuration version; the bundle rides on this answer',
        );
      }
      return {
        configVersion: version,
        config: readNodeConfig(db, node),
        ...upgrade,
      };
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
  { fleet, cache, rolling },
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
      return { nodes: fleet.all().map((node) => view(node, now)) };
    },
  );

  app.post(
    '/updateNodeSettings',
    {
      schema: {
        body: updateNodeSettingsRequestSchema,
        response: { 200: updateNodeSettingsResponseSchema },
      },
    },
    async (request, reply) => {
      const { id, swapGb } = request.body;
      const node = fleet.get(id);
      if (node === undefined) {
        throw refusal(
          404,
          `no node with id '${id}' — listNodes shows which exist`,
        );
      }
      // Whether this node's daemon can manage swap at all is the node's
      // word, carried in its reading (shared nodeReadingSchema managedSwap):
      // a target for a daemon that cannot honor it would sit in the row
      // forever, applied by nothing and shown by listNodes as if it were
      // real. Unknown (the node has never checked in — a row the import
      // pre-created) is unknown, not a guess either way; a node's last
      // reading outlives a gateway restart on its row (fleet.ts), so this
      // is never said of a node that has reported once.
      if (node.reading === null) {
        reply.header('retry-after', String(RETRY_AFTER_SECONDS));
        throw refusal(
          503,
          `node ${id} has never checked in, so whether its daemon manages swap is unknown — retry after its first check-in`,
        );
      }
      if (node.reading.managedSwap === null) {
        throw refusal(
          400,
          `node ${id} cannot manage swap: its daemon reports no managed-swap capability (a Linux host running the docker executor has it) — a target there would never be applied, so none is stored`,
        );
      }
      fleet.setSwapGb(id, swapGb);
      request.log.info(
        { nodeId: id, swapGb },
        'node swap target set; the node applies it at its next check-in',
      );
      return { node: view(node, new Date()) };
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
      // review, 2026-09-14). Judged from the row after a gateway restart
      // as from memory before one: a node that checked in seconds before
      // the restart is refused here at once, with no grace for the
      // gateway's own youth (the third cut's STARTUP_GRACE_MS, deleted
      // with the rows in the fourth). A row that has never checked in —
      // the import pre-creates one — has nothing here to protect.
      const node = fleet.get(request.body.id);
      if (node !== undefined && node.lastCheckInAt !== null) {
        const now = new Date();
        if (downReason(node, now) === null) {
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
      rolling.forget(request.body.id);
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

/** What listNodes and updateNodeSettings answer for one node: the row, the last check-in, the gateway's own counters. */
function view(node: NodeState, now: Date): NodeView {
  return {
    id: node.id,
    endpoint: node.endpoint,
    addedAt: node.addedAt,
    swapGb: node.swapGb,
    configVersion: node.configVersion,
    lastCheckInAt: node.lastCheckInAt?.toISOString() ?? null,
    intervalSeconds: node.intervalSeconds,
    reachable: downReason(node, now) === null,
    build: node.build,
    reading: node.reading,
    placedSinceCheckIn: node.placedSinceCheckIn,
  };
}
