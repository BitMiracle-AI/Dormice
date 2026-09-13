import type { FastifyReply } from 'fastify';
import type { Found } from '../find';
import type { NodeState } from '../fleet';
import { RETRY_AFTER_SECONDS } from '../raw';

/**
 * A finding turned into a routing decision for an authenticated face: the
 * node to forward to (with what the cache or the lookup knows of the
 * sandbox), nothing (every node answered and none holds it — a create
 * places, a destroy gives its idempotent answer, everything else a 404),
 * or a refusal with its status and sentence, which the face sends in its
 * own dialect. A value, so every verb reads the decision the same way.
 */
export type Verdict =
  | { kind: 'node'; node: NodeState; id: string; name: string | null }
  | { kind: 'none' }
  | {
      kind: 'refuse';
      status: number;
      message: string;
      retryAfterSeconds?: number;
    };

export function verdict(found: Found, what: string): Verdict {
  switch (found.kind) {
    case 'one':
      return { kind: 'node', node: found.node, id: found.id, name: found.name };
    case 'none':
      return { kind: 'none' };
    case 'conflict':
      // The gateway refuses every verb for this name with this very 409,
      // destroy included — it will not guess which copy the caller means.
      return {
        kind: 'refuse',
        status: 409,
        message: `${what} exists on nodes ${found.nodeIds.join(' and ')} — destroy one copy directly on its node before routing can resume`,
      };
    case 'unsure':
      return {
        kind: 'refuse',
        status: 503,
        message: `${what}: ${found.silent
          .map((s) => `node ${s.nodeId} did not answer (${s.why})`)
          .join(
            ', ',
          )} — it cannot be treated as new while a node that may hold it is silent; retry, or remove the node if it is gone for good`,
        retryAfterSeconds: RETRY_AFTER_SECONDS,
      };
  }
}

/** Sends a refusal in the native dialect, with Retry-After where the verdict carries one. */
export function refuse(
  reply: FastifyReply,
  refusal: Extract<Verdict, { kind: 'refuse' }>,
  body: (message: string) => unknown = (message) => ({ message }),
) {
  if (refusal.retryAfterSeconds !== undefined) {
    reply.header('retry-after', String(refusal.retryAfterSeconds));
  }
  return reply.code(refusal.status).send(body(refusal.message));
}
