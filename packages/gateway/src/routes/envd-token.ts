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

/** The verb's one name on the node, and the first of the door's two. */
const NODE_PATH = '/envdToken';

/**
 * The names the door answers this verb under — both, for good.
 * `/console/envdToken` is the name the verb was born with on the daemon:
 * the console's bridge from a session cookie to one sandbox's envd token,
 * behind the same API gate a Bearer token opens, so from the first day it
 * was also the one way for a server to mint an envd token without an E2B
 * connect. Clients took it up: clawsgo's server has minted its users'
 * sandbox tokens through it since July 2026 (22,000 calls a day on the
 * Hong Kong machine). The gateway's first version dropped the prefix
 * (2026-09-14), the first production cut-over (Hong Kong, 2026-09-17)
 * answered that client 1,809 404s in its first thirty-five minutes, and
 * the clone of its code that had been read to rule the path unused was
 * ten weeks stale. A public path is a promise: renaming one earns nothing
 * and costs every caller that kept its word. Both names stay — not a
 * transition, and not a redirect (a 308 on a POST is a second round trip
 * every client must be able to follow).
 */
const DOOR_PATHS = [NODE_PATH, '/console/envdToken'] as const;

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
  for (const url of DOOR_PATHS) {
    app.post(
      url,
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
            // own face); the node gets the same words re-serialized, under
            // the verb's one name there whichever the caller used.
            const answer = await forwardCapture(request.raw, reply.raw, {
              target: { endpoint: node.endpoint, token },
              credential: 'bearer',
              path: NODE_PATH,
              body: Buffer.from(JSON.stringify(request.body)),
            });
            if (answer !== null) replay(reply.raw, answer);
          },
          (error) => ({ status: 502, message: `${error.message} — retry` }),
        );
      },
    );
  }
};
