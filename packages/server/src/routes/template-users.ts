import {
  templateUsersRequestSchema,
  templateUsersResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../db/db';
import { sandboxNamesUsingTemplate } from '../db/templates';

export interface TemplateUsersRoutesOptions {
  db: Db;
}

/**
 * The gateway's second question on its own account (the first is
 * lookupSandbox): which sandboxes here still use a template? Asked of
 * every node before the gateway removes one, so no sandbox anywhere
 * wakes onto a dangling name. A ledger read, nothing more — no slot, no
 * wake, no touch.
 */
export const templateUsersRoutes: FastifyPluginAsyncZod<
  TemplateUsersRoutesOptions
> = async (app, { db }) => {
  app.post(
    '/templateUsers',
    {
      schema: {
        body: templateUsersRequestSchema,
        response: { 200: templateUsersResponseSchema },
      },
    },
    async (request) => ({
      sandboxNames: sandboxNamesUsingTemplate(db, request.body.name),
    }),
  );
};
