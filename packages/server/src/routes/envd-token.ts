import {
  envdTokenRequestSchema,
  envdTokenResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { mintEnvdToken } from '../e2b/protocol';

export interface EnvdTokenRoutesOptions {
  /**
   * HMAC key for the envd tokens this verb mints — the ledger's signing
   * secret, never the API token (they rotate independently).
   */
  envdSigningSecret: string;
}

/**
 * The console's terminal speaks to the envd surface directly — the same
 * wire the e2b SDK uses — but envd auth is the per-sandbox HMAC keyed by
 * this node's signing secret, which never leaves the node and the browser
 * deliberately never holds. This verb trades an API credential for exactly
 * one sandbox's token; the API-wide arbiter guards it like every other
 * verb. Minting is stateless on purpose (like the secret itself): a
 * made-up sandboxId yields a token that opens nothing. The gateway asks
 * the sandbox's node this question on the console's behalf.
 */
export const envdTokenRoutes: FastifyPluginAsyncZod<
  EnvdTokenRoutesOptions
> = async (app, { envdSigningSecret }) => {
  app.post(
    '/envdToken',
    {
      schema: {
        body: envdTokenRequestSchema,
        response: { 200: envdTokenResponseSchema },
      },
    },
    async (request) => ({
      envdAccessToken: mintEnvdToken(envdSigningSecret, request.body.sandboxId),
    }),
  );
};
