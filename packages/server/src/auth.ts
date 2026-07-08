import { createHash, timingSafeEqual } from 'node:crypto';
import type { onRequestAsyncHookHandler } from 'fastify';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/**
 * Bearer-token check for all API routes (/healthz stays open — liveness
 * probes have no secrets). Both sides are hashed before comparison so
 * timingSafeEqual gets equal-length inputs and the comparison stays
 * constant-time regardless of what the client sent.
 */
export function requireApiToken(token: string): onRequestAsyncHookHandler {
  const expected = sha256(`Bearer ${token}`);
  return async (request, reply) => {
    const presented = sha256(request.headers.authorization ?? '');
    if (!timingSafeEqual(presented, expected)) {
      await reply.code(401).send({ message: 'missing or invalid API token' });
    }
  };
}
