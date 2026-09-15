import {
  applyUpgradeRequestSchema,
  applyUpgradeResponseSchema,
  checkUpgradeRequestSchema,
  checkUpgradeResponseSchema,
  getUpgradeStatusRequestSchema,
  getUpgradeStatusResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { httpError } from '../http-error';
import type { Updater } from '../updater';

export interface UpgradeRoutesOptions {
  updater: Updater;
}

/**
 * The daemon's own upgrade surface: what commit am I (checkUpgrade), pull
 * the trigger (applyUpgrade), watch it land (getUpgradeStatus). Checking
 * reaches the network exactly when asked — no background phone-home — and
 * a server-side cache keeps repeats cheap. Applying hands install.sh to a
 * systemd transient unit that outlives the daemon's own restart; only the
 * launch is logged here, because the daemon that would log "finished" is
 * the one being replaced.
 */
export const upgradeRoutes: FastifyPluginAsyncZod<
  UpgradeRoutesOptions
> = async (app, { updater }) => {
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
      // The verb's `nodeId` half is the gateway's (the hand that puts a
      // stuck node back in line, gateway routes/upgrade.ts); on a node it
      // names nothing. Refused, not dropped: taken silently, a hand meant
      // for one node would upgrade whichever node it was sent to (found
      // by review, 2026-09-16).
      if (request.body.nodeId !== undefined) {
        throw httpError(
          400,
          "nodeId is the gateway's: applyUpgrade {nodeId} at the gateway puts a stuck node back in line; here, applyUpgrade {} upgrades this node itself",
        );
      }
      await updater.apply();
      request.log.info(
        { from: updater.current?.commit ?? null },
        'one-click upgrade launched (systemd unit dormice-upgrade)',
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
    async () => updater.status(),
  );
};
