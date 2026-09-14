import {
  envdTokenRequestSchema,
  envdTokenResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { relay } from '../errors';
import type { Finder } from '../find';
import { forwardCapture, replay } from '../forward';
import { httpError } from '../http-error';
import { refuse, verdict } from './verdict';

export interface EnvdTokenRoutesOptions {
  finder: Finder;
  token: string;
}

/**
 * envdToken through the gateway: the console (or any caller through the
 * door) names a sandbox by id; the gateway finds the node that runs it
 * and asks that node to mint, under the fleet token, and hands the answer
 * back verbatim. The token is an HMAC under the node's own signing secret
 * — nothing the gateway holds could mint it, which is exactly right: the
 * node that runs the sandbox is the one that judges its envd traffic.
 * Found by id, never by name: a terminal is opened on a sandbox the
 * caller already sees.
 */
export const envdTokenRoutes: FastifyPluginAsyncZod<
  EnvdTokenRoutesOptions
> = async (app, { finder, token }) => {
  app.post(
    '/envdToken',
    {
      schema: {
        body: envdTokenRequestSchema,
        response: { 200: envdTokenResponseSchema },
      },
    },
    async (request, reply) => {
      const { sandboxId } = request.body;
      const judged = verdict(
        await finder.byId(sandboxId),
        `sandbox "${sandboxId}"`,
      );
      if (judged.kind === 'refuse') return refuse(reply, judged);
      if (judged.kind === 'none') {
        throw httpError(404, `sandbox "${sandboxId}" is on no node`);
      }
      const { node } = judged;
      reply.hijack();
      await relay(
        reply.raw,
        'native',
        request.log,
        async () => {
          // The body was parsed by Fastify (a JSON verb on the gateway's
          // own face); the node gets the same words re-serialized.
          const answer = await forwardCapture(request.raw, reply.raw, {
            target: { endpoint: node.endpoint, token },
            credential: 'bearer',
            body: Buffer.from(JSON.stringify(request.body)),
          });
          if (answer !== null) replay(reply.raw, answer);
        },
        (error) => ({ status: 502, message: `${error.message} — retry` }),
      );
    },
  );
};
