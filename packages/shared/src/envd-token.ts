import { z } from 'zod';

/**
 * envdToken(sandboxId) — mints the per-sandbox envd access token the
 * in-sandbox API (E2B's envd surface: terminal, files, processes) accepts,
 * for a caller who is already through the API's front door. The console
 * uses it to open a terminal: the browser holds a session, never the
 * signing secret, and trades the one for exactly one sandbox's token.
 *
 * Minting is stateless: the token is an HMAC over the sandbox id under
 * the node's signing secret, so a made-up id yields a token that opens
 * nothing. Only the node that runs the sandbox can mint it (the secret
 * never leaves its ledger); the gateway finds that node by id and asks.
 */
export const envdTokenRequestSchema = z.object({
  sandboxId: z.string().min(1),
});

export type EnvdTokenRequest = z.infer<typeof envdTokenRequestSchema>;

export const envdTokenResponseSchema = z.object({
  envdAccessToken: z.string(),
});

export type EnvdTokenResponse = z.infer<typeof envdTokenResponseSchema>;
