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
 * A create whose client has already left: nothing is asked, placed or
 * counted for it — the response is gone, forwardCapture would send
 * nothing. Checked first thing inside the slot (a creator that waited
 * behind a slow create or destroy) and again after the lookup round (up
 * to two seconds). The reply is hijacked so Fastify writes nothing to the
 * dead socket either.
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
  /**
   * True when place() chose the target for a name no node held — the
   * placement was counted against it in placedSinceCheckIn. False for a
   * wake: the name was found on the target, its sandbox is in the reading
   * already, and nothing was counted that could be uncounted.
   */
  placed: boolean;
}

/**
 * Forwards a create and learns from the node's answer: a 2xx with a
 * readable id goes into the cache (name and id → this node), so the next
 * request for the sandbox skips the round of questions. A 2xx without a
 * readable id is logged — the sandbox exists on the node and the next
 * lookup finds it there, never silently.
 *
 * The placement count moves only for a placement (`placed`): a 2xx id
 * also goes into the node's placedIds, so a destroy inside the same
 * interval takes the placement off the count again; a 4xx or the node's
 * own 500 means the node built nothing, and the placement comes off the
 * count at once (it would have held a slot for a whole interval
 * otherwise), so the next attempt may be placed elsewhere. A wake — a
 * name found on the node — moves nothing either way: its sandbox is in
 * the reading already, and paying back a placement that never was would
 * open the gate one sandbox wider than the reading allows (found by
 * review, 2026-09-14). A 502/503/504 from a hop in front of the node, or
 * no answer at all, leaves the count as it is and the question to the
 * next lookup — the node that may have built it answers from inside the
 * name's slot.
 */
const HOP_STATUSES = new Set([502, 503, 504]);
export async function forwardCreate(
  cache: NameCache,
  request: FastifyRequest,
  res: http.ServerResponse,
  { target, token, name, body, face, placed }: CreateOptions,
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
      if (placed) target.placedIds.add(id);
    } else {
      request.log.warn(
        { node: target.id, name, status: answer.status },
        'create answered 2xx without a readable sandbox id; the next lookup finds it on the node',
      );
    }
  } else if (!HOP_STATUSES.has(answer.status)) {
    // The node itself answered no: nothing was built there.
    if (placed) {
      target.placedSinceCheckIn = Math.max(0, target.placedSinceCheckIn - 1);
    }
    if (answer.status >= 500) {
      request.log.warn(
        { node: target.id, name, status: answer.status },
        'the node itself failed the create; nothing cached, the placement is uncounted',
      );
    }
  } else {
    request.log.warn(
      { node: target.id, name, status: answer.status },
      'a hop in front of the node answered the create; nothing cached, the placement stays counted until the next reading',
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
