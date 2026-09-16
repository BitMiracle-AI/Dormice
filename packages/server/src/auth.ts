import { createHash, timingSafeEqual } from 'node:crypto';
import type { onRequestAsyncHookHandler } from 'fastify';

/**
 * A node's whole authentication: the fleet token, and nothing else. Since
 * the configuration authority moved to the gateway (design record #22,
 * 2026-09-14) a node knows one credential — the token every node and the
 * gateway share (#34) — and judges nothing about who is behind it: minted
 * API keys, the console's session cookie and the admin gate are the
 * gateway's (packages/gateway/src/auth.ts), which speaks this token toward
 * the node whoever called it. The two faces of a node — the native Bearer
 * header and the E2B X-API-KEY hook (e2b/control.ts) — feed the one
 * closure app.ts builds over tokensEqual: one truth, two dialects.
 */

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time string comparison; both sides hashed so lengths never leak. */
export function tokensEqual(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

/**
 * The single arbiter of who may call a node's API (/healthz stays open —
 * liveness probes have no secrets): a Bearer credential that isCredential
 * accepts. The 'Bearer ' prefix is public framing, not a secret, so
 * stripping it needs no constant time; the secret comparison lives inside
 * isCredential.
 */
export function requireApiAuth(
  isCredential: (bareToken: string) => boolean,
): onRequestAsyncHookHandler {
  return async (request, reply) => {
    const header = request.headers.authorization;
    const bare = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (bare !== null && isCredential(bare)) {
      return;
    }
    await reply.code(401).send({ message: 'missing or invalid API token' });
  };
}
