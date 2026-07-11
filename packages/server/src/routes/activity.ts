import {
  listActivityRequestSchema,
  listActivityResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { listActivityEvents } from '../db/activity';
import type { Db } from '../db/db';

export interface ActivityRoutesOptions {
  db: Db;
}

/**
 * The ledger's recent history — the explanation window beside the
 * observation windows (listSandboxes for now, getHostMetrics for the
 * machine). Read-only over the activity ring; recording happens where the
 * moves themselves happen.
 */
export const activityRoutes: FastifyPluginAsyncZod<
  ActivityRoutesOptions
> = async (app, { db }) => {
  app.post(
    '/listActivity',
    {
      schema: {
        body: listActivityRequestSchema,
        response: { 200: listActivityResponseSchema },
      },
    },
    async (request) => ({
      events: listActivityEvents(db, request.body.limit),
    }),
  );
};
