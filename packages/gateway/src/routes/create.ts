import type http from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { NameCache } from '../cache';
import type { Fleet, NodeState } from '../fleet';
import {
  type CapturedResponse,
  type Credential,
  forwardCapture,
} from '../forward';
import { type Placement, type PlacementKnobs, pick } from '../placement';

/**
 * What a create looks like on each face the gateway creates through: the
 * credential it forwards under, and where the node's answer keeps the id
 * it minted — all the gateway ever reads of that answer.
 */
export interface CreateFace {
  credential: Credential;
  idOf(answer: unknown): string | null;
}

const acquireAnswerSchema = z.object({ sandbox: z.object({ id: z.string() }) });
const e2bAnswerSchema = z.object({ sandboxID: z.string() });

export const NATIVE_CREATE: CreateFace = {
  credential: 'bearer',
  idOf: (answer) => {
    const parsed = acquireAnswerSchema.safeParse(answer);
    return parsed.success ? parsed.data.sandbox.id : null;
  },
};

export const E2B_CREATE: CreateFace = {
  credential: 'x-api-key',
  idOf: (answer) => {
    const parsed = e2bAnswerSchema.safeParse(answer);
    return parsed.success ? parsed.data.sandboxID : null;
  },
};

/**
 * Where a new sandbox goes: placement's pick, counted against the node at
 * once — the next acquire in this same interval must see this one as
 * already there. Nothing is recorded anywhere else: if the answer is
 * lost, the caller's retry asks the fleet (find.ts) and the node that
 * built it answers "yes" from inside the name's slot.
 */
export function place(
  fleet: Fleet,
  knobs: PlacementKnobs,
  now: Date,
): Placement {
  const placement = pick(fleet.all(), knobs, now);
  if (placement.node !== null) placement.node.placedSinceCheckIn += 1;
  return placement;
}

/**
 * A create that waited for its name's slot behind a slow destroy and whose
 * client left meanwhile: nothing is placed or counted for it — the
 * response is gone, forwardCapture would send nothing. The reply is
 * hijacked so Fastify writes nothing to the dead socket either.
 */
export function clientGone(reply: FastifyReply): boolean {
  if (!reply.raw.destroyed) return false;
  reply.hijack();
  return true;
}

export interface CreateOptions {
  target: NodeState;
  token: string;
  name: string | null;
  body: Buffer | undefined;
  face: CreateFace;
}

/**
 * Forwards a create and learns from the node's answer: a 2xx with a
 * readable id goes into the cache (name and id → this node), so the next
 * request for the sandbox skips the round of questions. A 2xx without a
 * readable id is logged — the sandbox exists on the node and the next
 * lookup finds it there, never silently. Any other answer teaches
 * nothing: a 4xx or the node's own 500 means the node holds nothing under
 * the name and the next attempt may be placed elsewhere; a 502/503/504
 * from a hop in front of the node, or no answer at all, leaves the
 * question to the next lookup — the node that may have built it answers
 * from inside the name's slot.
 */
export async function forwardCreate(
  cache: NameCache,
  request: FastifyRequest,
  res: http.ServerResponse,
  { target, token, name, body, face }: CreateOptions,
): Promise<CapturedResponse | null> {
  const answer = await forwardCapture(request.raw, res, {
    target: { endpoint: target.endpoint, token },
    credential: face.credential,
    body,
  });
  if (answer === null) return null;
  if (answer.status >= 200 && answer.status < 300) {
    const id = face.idOf(parseJson(answer.body));
    if (id !== null) {
      cache.put({ id, name, nodeId: target.id });
    } else {
      request.log.warn(
        { node: target.id, name, status: answer.status },
        'create answered 2xx without a readable sandbox id; the next lookup finds it on the node',
      );
    }
  } else if (answer.status >= 500) {
    request.log.warn(
      { node: target.id, name, status: answer.status },
      'create was refused by the node or a hop in front of it; nothing cached',
    );
  }
  return answer;
}

export function parseJson(body: Buffer | undefined): unknown {
  if (body === undefined || body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}
