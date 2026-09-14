import type { KeyedQueue } from '@dormice/server/keyed-queue';
import { sandboxNameSchema } from '@dormice/shared';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AskVerb } from '../ask';
import { decodeCursor, encodeCursor, mergePages } from '../cursor';
import { relay } from '../errors';
import type { Finder } from '../find';
import type { Fleet, NodeState } from '../fleet';
import { forwardStream, replay } from '../forward';
import { askEach } from '../merge';
import { type PlacementKnobs, refusalMessage } from '../placement';
import { RETRY_AFTER_SECONDS } from '../raw';
import {
  clientGone,
  E2B_CREATE,
  forwardCreate,
  parseJson,
  place,
} from './create';
import { forwardDestroy } from './destroy';
import { refuse, verdict } from './verdict';

export interface E2bRoutesOptions {
  fleet: Fleet;
  finder: Finder;
  locks: KeyedQueue;
  knobs: PlacementKnobs;
  /** The fleet token, presented to the nodes when forwarding. */
  token: string;
  /** The app's one adjudication of a bare credential (fleet token or a live minted key). */
  isCredential: (bareToken: string) => boolean;
  /** Asks one node one verb on the gateway's account (ask.ts httpAsk) — the list. */
  ask: AskVerb;
}

/** The daemon's own bounds on a page (e2b/control.ts listQuerySchema), judged here first so every node is asked for the same page. */
const listLimitSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(1000)
  .default(100);

/** What the gateway reads of a node's list item: the two fields the merge orders by. Everything else passes through as the node wrote it. */
const e2bListItemSchema = z
  .object({ sandboxID: z.string(), startedAt: z.string() })
  .loose();

/**
 * The E2B control plane in front of several nodes: what the official SDK
 * calls api.e2b.app for, mounted at /e2b/api like the daemon's. Creates
 * are placed (by metadata.name when the SDK gave one — the same name slot
 * the native acquire takes — else unnamed, known by id alone until a
 * lookup names it); everything addressed by id is found and forwarded.
 * The dialect is E2B's: { code: <status>, message }.
 */
export const e2bControlRoutes: FastifyPluginAsyncZod<E2bRoutesOptions> = async (
  app,
  { fleet, finder, locks, knobs, token, isCredential, ask },
) => {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error(error, 'request failed');
    reply.code(status).send({ code: status, message: error.message });
  });
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      code: 404,
      message: `route ${request.method} ${request.url} not found`,
    });
  });

  // The daemon's own X-API-KEY convention (`e2b_<credential>`; the prefix
  // is the SDK's, not a secret): the fleet token or any live key the
  // gateway minted, judged by the same closure as the native Bearer face.
  app.addHook('onRequest', async (request, reply) => {
    const presented = request.headers['x-api-key'];
    const key = Array.isArray(presented) ? presented[0] : presented;
    const bare = key?.startsWith('e2b_') ? key.slice(4) : key;
    if (bare === undefined || !isCredential(bare)) {
      await reply.code(401).send({ code: 401, message: 'invalid API key' });
    }
  });

  const send = (reply: FastifyReply, code: number, message: string) =>
    reply.code(code).send({ code, message });

  /** From the hijack on the raw response is the gateway's to finish, in E2B's dialect (errors.ts relay). */
  const forwarded = (
    request: FastifyRequest,
    reply: FastifyReply,
    tail: string,
    step: () => Promise<void>,
  ) => {
    reply.hijack();
    return relay(reply.raw, 'control', request.log, step, (error) => ({
      status: 502,
      message: `${error.message}${tail}`,
    }));
  };

  const RETRY_FINDS_IT =
    ' — retry: if the sandbox was built, the node answers for it';

  /** `placed`: pick() chose the node for a new name (counted there) — false for a name found on it, a wake. */
  function create(
    request: FastifyRequest,
    reply: FastifyReply,
    target: NodeState,
    name: string | null,
    body: Buffer | undefined,
    placed: boolean,
  ) {
    return forwarded(request, reply, RETRY_FINDS_IT, async () => {
      const answer = await forwardCreate(finder.cache, request, reply.raw, {
        target,
        token,
        name,
        body,
        face: E2B_CREATE,
        placed,
      });
      if (answer !== null) replay(reply.raw, answer);
    });
  }

  /** Places a new sandbox, or sends the 503 and answers null (null too for a client that already left). */
  function placeOrRefuse(reply: FastifyReply): NodeState | null {
    if (clientGone(reply)) return null;
    const placement = place(fleet, knobs, new Date());
    if (placement.node === null) {
      reply.header('retry-after', String(RETRY_AFTER_SECONDS));
      send(reply, 503, refusalMessage(placement));
      return null;
    }
    return placement.node;
  }

  app.post('/sandboxes', async (request, reply) => {
    const body = request.body as Buffer | undefined;
    const parsed = parseJson(body) as
      | { metadata?: { name?: unknown } }
      | undefined;
    if (parsed?.metadata?.name !== undefined) {
      // Judged by the wire's own rule before any node is asked (native.ts
      // nameOf has why); the node's stricter E2B pattern still answers its
      // own 400, relayed as it came.
      const judged = sandboxNameSchema.safeParse(parsed.metadata.name);
      if (!judged.success) {
        return send(
          reply,
          400,
          `invalid metadata.name: ${judged.error.issues[0]?.message ?? 'refused by the wire'}`,
        );
      }
      const name = judged.data;
      return locks.run(name, async () => {
        // A client that left while waiting for the slot asks nobody
        // (native.ts acquire has why).
        if (clientGone(reply)) return reply;
        // Confirmed with the cached node first (find.ts byName has why):
        // the daemon's create builds what it does not find.
        const found = verdict(
          await finder.byName(name, { confirm: true }),
          `sandbox "${name}"`,
        );
        if (found.kind === 'refuse') {
          return refuse(reply, found, (message) => ({
            code: found.status,
            message,
          }));
        }
        if (found.kind === 'node') {
          return create(request, reply, found.node, name, body, false);
        }
        const target = placeOrRefuse(reply);
        if (target === null) return reply;
        return create(request, reply, target, name, body, true);
      });
    }
    const target = placeOrRefuse(reply);
    if (target === null) return reply;
    return create(request, reply, target, null, body, true);
  });

  // The list across nodes: every askable node is asked its own page from
  // its own offset (cursor.ts carries every node's), the pages are merged
  // newest first and cut at the caller's limit. A node the answer would
  // lack is a 503 naming it, not a shorter list: this wire is a bare
  // array with nowhere to say what is missing, and the SDK's paginator
  // would take a partial page for the whole fleet. The daemon judges
  // `state` and `metadata`; the gateway reads only limit and the cursor.
  app.get('/v2/sandboxes', async (request, reply) => {
    const url = request.raw.url ?? '';
    const q = url.indexOf('?');
    const query = new URLSearchParams(q === -1 ? '' : url.slice(q + 1));
    const limit = listLimitSchema.safeParse(query.get('limit') ?? undefined);
    if (!limit.success) {
      return send(
        reply,
        400,
        `invalid limit: ${limit.error.issues[0]?.message ?? 'refused'}`,
      );
    }
    const token_ = query.get('nextToken');
    const offsets =
      token_ === null || token_ === '' ? {} : decodeCursor(token_);
    if (offsets === null) {
      return send(
        reply,
        400,
        'invalid nextToken — pass back the x-next-token of the previous page unchanged',
      );
    }
    query.delete('nextToken');
    query.set('limit', String(limit.data));
    const { answers, silent } = await askEach(fleet, ask, {
      verb: (node) => {
        const own = new URLSearchParams(query);
        const offset = offsets[node.id] ?? 0;
        if (offset > 0) own.set('nextToken', String(offset));
        return `e2b/api/v2/sandboxes?${own.toString()}`;
      },
      schema: z.array(e2bListItemSchema),
      options: { method: 'GET', credential: 'x-api-key' },
    });
    if (silent.length > 0) {
      reply.header('retry-after', String(RETRY_AFTER_SECONDS));
      return send(
        reply,
        503,
        `the list is incomplete: ${silent
          .map((s) => `node ${s.nodeId} did not answer (${s.why})`)
          .join(
            ', ',
          )} — retry after Retry-After, or remove the node if it is gone for good`,
      );
    }
    const page = mergePages(
      answers.map((a) => ({
        nodeId: a.node.id,
        items: a.value,
        more: a.headers.get('x-next-token') !== null,
      })),
      offsets,
      limit.data,
    );
    if (page.next !== null) {
      reply.header('x-next-token', encodeCursor(page.next));
    }
    return reply.code(200).send(page.items);
  });

  const byId = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const judged = verdict(await finder.byId(id), `sandbox "${id}"`);
    if (judged.kind === 'refuse') {
      return refuse(reply, judged, (message) => ({
        code: judged.status,
        message,
      }));
    }
    if (judged.kind === 'none') {
      return send(reply, 404, `sandbox "${id}" not found`);
    }
    const body = request.body as Buffer | undefined;
    const { node, name } = judged;
    // Only the kill itself — DELETE /sandboxes/<id>, nothing deeper — is
    // captured and learned from (routes/destroy.ts has what is learned).
    // A DELETE on a sub-route the node lacks answers the same 404 shape as
    // a kill of an unknown id (measured 2026-09-12 with
    // DELETE /sandboxes/<id>/bogus). The kill takes the name's slot like
    // the native destroy (the daemon's own kill does too).
    if (request.method === 'DELETE' && isKill(request)) {
      return locks.run(name ?? id, () =>
        forwarded(request, reply, ' — retry', async () => {
          const answer = await forwardDestroy(
            finder.cache,
            request,
            reply.raw,
            {
              target: node,
              token,
              entry: { id, name, nodeId: node.id },
              body,
              credential: 'x-api-key',
            },
          );
          if (answer !== null) replay(reply.raw, answer);
        }),
      );
    }
    return forwarded(request, reply, ' — retry', async () => {
      const status = await forwardStream(request.raw, reply.raw, {
        target: { endpoint: node.endpoint, token },
        credential: 'x-api-key',
        body,
      });
      if (status === 404) void finder.verify({ id, name, nodeId: node.id });
    });
  };
  // Every method, not the ones this build of the daemon happens to serve:
  // the node answers for its own routes (e2b 2.31 already PUTs
  // /sandboxes/:id/network, which the daemon 404s — its 404, not the
  // gateway's, is the honest one). The path reaches the node exactly as
  // written (forward.ts dispatch), so a sub-route is a sub-route there
  // too, never a create resolved out of dot segments.
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
  app.route({ method: [...methods], url: '/sandboxes/:id', handler: byId });
  app.route({ method: [...methods], url: '/sandboxes/:id/*', handler: byId });
};

/** The kill route exactly: `/sandboxes/<id>` with nothing after the id. */
function isKill(request: FastifyRequest): boolean {
  return (request.params as { '*'?: string })['*'] === undefined;
}
