import {
  listTemplatesResponseSchema,
  registerTemplateRequestSchema,
  registerTemplateResponseSchema,
  removeTemplateRequestSchema,
  removeTemplateResponseSchema,
  templateUsersResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/db';
import {
  listTemplates,
  registerTemplate,
  removeTemplate,
} from '../db/templates';
import type { Fleet } from '../fleet';
import type { AskVerb } from '../lookup';
import { RETRY_AFTER_SECONDS } from '../raw';

export interface TemplateRoutesOptions {
  db: Db;
  fleet: Fleet;
  /** Asks one node one verb on the gateway's account (lookup.ts httpAsk). */
  ask: AskVerb;
}

/**
 * Templates, fleet-wide: a name for an image, registered once here and
 * carried to every node in the configuration bundle (design record #29 —
 * a template sandbox's cold wake resolves name → image on its node, with
 * or without a gateway present). Registration is configuration, not a
 * check: the image is not looked for anywhere — it may legitimately
 * arrive later, and a node whose Docker lacks it fails the create with
 * Docker's own honest error, as the daemon always has.
 *
 * Removal is the one verb that needs the nodes: a template deleted under
 * a sandbox would wake it onto a dangling name, and the sandboxes live on
 * the nodes' ledgers. So every node is asked (templateUsers, two seconds,
 * in parallel — the lookup's discipline) and the removal is refused while
 * any node names a sandbox (409, the names by node) or any node is silent
 * (503, Retry-After: a silent node may hold users nobody can see).
 */
export const templateRoutes: FastifyPluginAsyncZod<
  TemplateRoutesOptions
> = async (app, { db, fleet, ask }) => {
  app.post(
    '/registerTemplate',
    {
      schema: {
        body: registerTemplateRequestSchema,
        response: { 200: registerTemplateResponseSchema },
      },
    },
    async (request) => {
      const template = registerTemplate(db, request.body);
      request.log.info(
        { template: template.name, image: template.image },
        'template registered; the nodes learn it at their next check-in',
      );
      return { template };
    },
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
        response: {
          200: removeTemplateResponseSchema,
          409: z.object({ message: z.string() }),
          503: z.object({ message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { name } = request.body;
      const answers = await Promise.all(
        fleet.all().map(async (node) => ({
          node,
          asked: await ask(
            node,
            'templateUsers',
            { name },
            templateUsersResponseSchema,
          ),
        })),
      );
      const silent = answers.flatMap(({ node, asked }) =>
        asked.kind === 'silent' ? [`node ${node.id} (${asked.why})`] : [],
      );
      if (silent.length > 0) {
        reply.header('retry-after', String(RETRY_AFTER_SECONDS));
        return reply.code(503).send({
          message: `cannot remove template '${name}' while a node has not answered whether its sandboxes use it: ${silent.join(', ')} — retry after Retry-After, or remove the node if it is gone for good`,
        });
      }
      const users = answers.flatMap(({ node, asked }) =>
        asked.kind === 'answer' && asked.value.sandboxNames.length > 0
          ? [`${asked.value.sandboxNames.join(', ')} on node ${node.id}`]
          : [],
      );
      if (users.length > 0) {
        return reply.code(409).send({
          message: `template '${name}' is used by sandboxes: ${users.join('; ')} — destroy them or move them to another template first`,
        });
      }
      const removed = removeTemplate(db, name);
      if (removed) {
        request.log.info(
          { template: name },
          'template removed; the nodes drop it at their next check-in',
        );
      }
      return { removed };
    },
  );
};
