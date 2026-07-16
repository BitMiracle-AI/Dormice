import {
  listTemplatesResponseSchema,
  registerTemplateRequestSchema,
  registerTemplateResponseSchema,
  removeTemplateRequestSchema,
  removeTemplateResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../db/db';
import {
  listTemplates,
  registerTemplate,
  removeTemplate,
  sandboxNamesUsingTemplate,
} from '../db/templates';
import { httpError } from '../http-error';

export interface TemplateRoutesOptions {
  db: Db;
}

/**
 * Template registration: a name for a Docker image that already lives on
 * this host. Pure ledger config — no executor involved: the image is not
 * checked for existence (it may legitimately arrive after registration; a
 * missing one fails a later create with Docker's own honest error), and
 * removal only guards the ledger's referential integrity.
 */
export const templateRoutes: FastifyPluginAsyncZod<
  TemplateRoutesOptions
> = async (app, { db }) => {
  // Upsert: re-registering a name re-points it at the new image — the
  // template upgrade front door. No lock: better-sqlite3 is synchronous,
  // there is no await between check and write.
  app.post(
    '/registerTemplate',
    {
      schema: {
        body: registerTemplateRequestSchema,
        response: { 200: registerTemplateResponseSchema },
      },
    },
    async (request) => ({
      template: registerTemplate(db, request.body),
    }),
  );

  app.post(
    '/listTemplates',
    {
      schema: {
        response: { 200: listTemplatesResponseSchema },
      },
    },
    async () => ({ templates: listTemplates(db) }),
  );

  app.post(
    '/removeTemplate',
    {
      schema: {
        body: removeTemplateRequestSchema,
        response: { 200: removeTemplateResponseSchema },
      },
    },
    async (request) => {
      const { name } = request.body;
      // Refused while referenced: a sandbox row pointing at a removed
      // template would wake onto a dangling name. Named keys, so the
      // operator knows exactly what to destroy.
      const users = sandboxNamesUsingTemplate(db, name);
      if (users.length > 0) {
        throw httpError(
          409,
          `template '${name}' is used by ${users.length} sandbox(es): ${users.join(', ')} — destroy them first`,
        );
      }
      return { removed: removeTemplate(db, name) };
    },
  );
};
