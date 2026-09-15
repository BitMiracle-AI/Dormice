import type { Updater } from '@dormice/server/updater';
import {
  applyUpgradeRequestSchema,
  applyUpgradeResponseSchema,
  checkUpgradeRequestSchema,
  checkUpgradeResponseSchema,
  getUpgradeStatusRequestSchema,
  getUpgradeStatusResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Fleet } from '../fleet';
import { httpError } from '../http-error';
import type { Rolling } from '../rolling';

export interface UpgradeRoutesOptions {
  /** The gateway's own upgrade window over its machine's checkout (the daemon's Updater, through @dormice/server/updater). */
  updater: Updater;
  fleet: Fleet;
  rolling: Rolling;
}

/**
 * The fleet's upgrade surface, at the door (RULES/协议.md「舰队升级」):
 * checkUpgrade compares the gateway's build against origin's main;
 * applyUpgrade without a node upgrades the gateway's machine — install.sh
 * in a systemd unit, the daemon's own mechanism, which restarts the
 * gateway and its node together, and from then on the check-ins roll the
 * upgrade over the other nodes (rolling.ts); applyUpgrade with a node is
 * the operator's re-tell of one node; getUpgradeStatus is the gateway
 * machine's run plus every node's standing. Behind the admin gate: an
 * upgrade is the fleet's configuration in the largest sense, and a leaked
 * automation key must not be able to restart every machine.
 */
export const upgradeRoutes: FastifyPluginAsyncZod<
  UpgradeRoutesOptions
> = async (app, { updater, fleet, rolling }) => {
  app.post(
    '/checkUpgrade',
    {
      schema: {
        body: checkUpgradeRequestSchema,
        response: { 200: checkUpgradeResponseSchema },
      },
    },
    async (request) => updater.check(request.body.force),
  );

  app.post(
    '/applyUpgrade',
    {
      schema: {
        body: applyUpgradeRequestSchema,
        response: { 200: applyUpgradeResponseSchema },
      },
    },
    async (request) => {
      const { nodeId } = request.body;
      if (nodeId === undefined) {
        await updater.apply();
        request.log.info(
          { from: updater.current?.commit ?? null },
          "fleet upgrade launched: install.sh runs on the gateway's machine (systemd unit dormice-upgrade); the other nodes are told at their check-ins once the gateway is back on the new build",
        );
        return { started: true as const };
      }
      const node = fleet.get(nodeId);
      if (node === undefined) {
        throw httpError(
          404,
          `no node with id '${nodeId}' — listNodes shows which exist`,
        );
      }
      const refused = rolling.requestRetell(node, new Date());
      if (refused !== null) throw httpError(refused.status, refused.message);
      request.log.info(
        { nodeId, build: node.build?.commit ?? null },
        'node told to upgrade again by the operator; it hears at its next check-in',
      );
      return { started: true as const };
    },
  );

  app.post(
    '/getUpgradeStatus',
    {
      schema: {
        body: getUpgradeStatusRequestSchema,
        response: { 200: getUpgradeStatusResponseSchema },
      },
    },
    async () => ({
      ...(await updater.status()),
      nodes: rolling.states(new Date()),
    }),
  );
};
