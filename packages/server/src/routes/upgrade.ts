import {
  applyUpgradeRequestSchema,
  applyUpgradeResponseSchema,
  checkUpgradeRequestSchema,
  checkUpgradeResponseSchema,
  getUpgradeStatusRequestSchema,
  getUpgradeStatusResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { recordActivity } from '../db/activity';
import type { Db } from '../db/db';
import type { Updater } from '../updater';

export interface UpgradeRoutesOptions {
  updater: Updater;
  db: Db;
}

/**
 * The daemon's own upgrade surface: what commit am I (checkUpgrade), pull
 * the trigger (applyUpgrade), watch it land (getUpgradeStatus). Checking
 * reaches the network exactly when asked — no background phone-home — and
 * a server-side cache keeps repeats cheap. Applying hands install.sh to a
 * systemd transient unit that outlives the daemon's own restart; only the
 * launch is recorded in the activity ring, because the daemon that would
 * record "finished" is the one being replaced.
 */
export const upgradeRoutes: FastifyPluginAsyncZod<
  UpgradeRoutesOptions
> = async (app, { updater, db }) => {
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
      await updater.apply();
      const current = updater.current;
      recordActivity(db, {
        kind: 'upgrade-started',
        actor: request.actor,
        detail: `one-click upgrade launched${current ? ` from ${current.commit}` : ''} (systemd unit dormice-upgrade)`,
      });
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
