import {
  checkUpgradeRequestSchema,
  checkUpgradeResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Updater } from '../updater';

export interface UpgradeRoutesOptions {
  updater: Updater;
}

/**
 * The daemon's own upgrade window: what commit am I, what does origin's
 * main have that I lack. Checking reaches the network exactly when asked
 * (no background phone-home — the check runs on an operator's click, and
 * a server-side cache keeps repeats cheap); failures are honest data in
 * checkError, not invented freshness.
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
};
