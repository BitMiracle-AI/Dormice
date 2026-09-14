import type { KeyedQueue } from '@dormice/server/keyed-queue';
import {
  sandboxNameSchema,
  WRITE_FILES_BODY_LIMIT_BYTES,
} from '@dormice/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { relay } from '../errors';
import type { Finder } from '../find';
import type { Fleet } from '../fleet';
import { forwardStream, replay } from '../forward';
import { type PlacementKnobs, refusalMessage } from '../placement';
import { RETRY_AFTER_SECONDS } from '../raw';
import {
  clientGone,
  forwardCreate,
  NATIVE_CREATE,
  parseJson,
  place,
} from './create';
import { forwardDestroy } from './destroy';
import { refuse, verdict } from './verdict';

/**
 * The native verbs the gateway routes: every verb addressed to one sandbox
 * by `name`. Registered one by one — never as `/:verb` — so a misspelled
 * verb is a 404 like on the daemon, and nothing else under the root is
 * swallowed.
 */
export const NAMED_VERBS = [
  'acquireSandbox',
  'execCommand',
  'writeFile',
  'writeFiles',
  'readFile',
  'readFiles',
  'rebuildSandbox',
  'updatePolicy',
  'updateSpec',
  'updateTemplate',
  'expandDisk',
  'updateMetadata',
  'destroySandbox',
  'getSandboxMetrics',
  'getSandboxMetricsHistory',
] as const;

/**
 * The verbs that address the daemon, not a sandbox: fleet lists, host
 * readings, templates, settings, ingress, upgrade. The ones the gateway
 * answers from its own tables leave this list as they arrive (the API
 * keys did with the configuration authority); asking every node and
 * merging the rest comes in a later cut. Until then each answers an
 * honest 501 naming the alternative, instead of a misleading answer from
 * whichever node the gateway happened to pick.
 */
export const UNNAMED_VERBS = [
  'listSandboxes',
  'listSandboxMetrics',
  'listSandboxImages',
  'getFleetTimeline',
  'getHostMetrics',
  'getHostMetricsHistory',
  'getConfig',
  'checkUpgrade',
  'applyUpgrade',
  'getUpgradeStatus',
  'getIngress',
  'setIngress',
  'registerTemplate',
  'listTemplates',
  'removeTemplate',
  'updateSettings',
] as const;

export interface NativeRoutesOptions {
  fleet: Fleet;
  finder: Finder;
  locks: KeyedQueue;
  knobs: PlacementKnobs;
  token: string;
}

export const nativeRoutes: FastifyPluginAsyncZod<NativeRoutesOptions> = async (
  app,
  { fleet, finder, locks, knobs, token },
) => {
  // Bodies stay bytes: the gateway reads one field (`name`) and forwards
  // the bytes it received, never a re-serialization. Scoped to this
  // plugin — the gateway's own verbs keep Fastify's JSON parsing.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  for (const verb of UNNAMED_VERBS) {
    app.post(`/${verb}`, async (_request, reply) =>
      reply.code(501).send({
        message: `${verb} is not routed by the gateway yet — call the node directly (this version routes only sandbox-addressed verbs)`,
      }),
    );
  }

  for (const verb of NAMED_VERBS) {
    const bodyLimit =
      verb === 'writeFile' || verb === 'writeFiles'
        ? WRITE_FILES_BODY_LIMIT_BYTES
        : undefined;
    app.post(
      `/${verb}`,
      bodyLimit === undefined ? {} : { bodyLimit },
      async (request, reply) => {
        const body = request.body as Buffer | undefined;
        const named = nameOf(body);
        if ('refusal' in named) {
          return reply.code(400).send({ message: named.refusal });
        }
        const { name } = named;
        // The gateway takes the name's slot for the two verbs whose
        // outcome it acts on — a create it may have to place, a destroy it
        // must forget — so twenty simultaneous acquires of a new name
        // place once: the first finds nothing and places, the rest find
        // its cache entry. Every other verb is relayed unserialized: the
        // daemon holds its own slot per name for the ones that touch the
        // sandbox (routes/sandboxes.ts locks.run), and a relay in front of
        // it has nothing to add to their order.
        if (verb === 'acquireSandbox') {
          return locks.run(name, () => acquire(request, reply, name, body));
        }
        if (verb === 'destroySandbox') {
          return locks.run(name, () => destroy(request, reply, name, body));
        }
        return forwardNamed(request, reply, name, body);
      },
    );
  }

  /**
   * From the hijack on, the raw response is the gateway's to finish: the
   * node's answer is replayed, or the gateway's own 502/500 rendered, in
   * the native dialect (errors.ts relay). `tail` is what the caller may
   * do after a node that did not answer.
   */
  const forwarded = (
    request: FastifyRequest,
    reply: FastifyReply,
    tail: string,
    step: () => Promise<void>,
  ) => {
    reply.hijack();
    return relay(reply.raw, 'native', request.log, step, (error) => ({
      status: 502,
      message: `${error.message}${tail}`,
    }));
  };

  /** A create that did not answer: the sandbox may exist; the retry asks the fleet and lands on the node that built it. */
  const RETRY_FINDS_IT =
    ' — retry: if the sandbox was built, the node answers for it';

  async function acquire(
    request: FastifyRequest,
    reply: FastifyReply,
    name: string,
    body: Buffer | undefined,
  ) {
    // First, before any node is asked: a creator that waited for the slot
    // behind a slow create or destroy and whose client left meanwhile
    // asks nobody — the confirmation below is a question to a node inside
    // the slot, and twenty abandoned acquires of one name would otherwise
    // hold the slot for twenty answers nobody reads (create.ts clientGone).
    if (clientGone(reply)) return;
    // A creator confirms a cache hit with its node first (find.ts byName
    // has why): the daemon's acquire builds what it does not find.
    const judged = verdict(
      await finder.byName(name, { confirm: true }),
      `sandbox "${name}"`,
    );
    if (judged.kind === 'refuse') return refuse(reply, judged);
    let target = judged.kind === 'node' ? judged.node : null;
    // Found nowhere: a placement, counted against the node it lands on.
    // Found somewhere — and confirmed there: a wake, already in that
    // node's reading.
    const placed = target === null;
    if (target === null) {
      // Asked again: the round of questions took up to two seconds.
      if (clientGone(reply)) return;
      const placement = place(fleet, knobs, new Date());
      if (placement.node === null) {
        reply.header('retry-after', String(RETRY_AFTER_SECONDS));
        return reply.code(503).send({ message: refusalMessage(placement) });
      }
      target = placement.node;
    }
    const chosen = target;
    return forwarded(request, reply, RETRY_FINDS_IT, async () => {
      const answer = await forwardCreate(finder.cache, request, reply.raw, {
        target: chosen,
        token,
        name,
        body,
        face: NATIVE_CREATE,
        placed,
      });
      if (answer !== null) replay(reply.raw, answer);
    });
  }

  async function destroy(
    request: FastifyRequest,
    reply: FastifyReply,
    name: string,
    body: Buffer | undefined,
  ) {
    const judged = verdict(await finder.byName(name), `sandbox "${name}"`);
    if (judged.kind === 'refuse') return refuse(reply, judged);
    // Nothing to forward: every node answered and none holds the name,
    // which is exactly the daemon's own idempotent answer.
    if (judged.kind === 'none')
      return reply.code(200).send({ destroyed: false });
    const { node, id } = judged;
    return forwarded(request, reply, ' — retry', async () => {
      const answer = await forwardDestroy(finder.cache, request, reply.raw, {
        target: node,
        token,
        entry: { id, name, nodeId: node.id },
        body,
        credential: 'bearer',
      });
      if (answer !== null) replay(reply.raw, answer);
    });
  }

  /**
   * Every other named verb: find the node, stream the answer through as
   * it came — status, headers, body. A node's 404 is not "no such
   * sandbox" by itself (readFile answers 404 for a missing path too), so
   * it is relayed as it came and the cache entry is re-checked off the
   * request path (find.ts verify): only a node that says "absent" to the
   * one question that means it loses the entry.
   */
  async function forwardNamed(
    request: FastifyRequest,
    reply: FastifyReply,
    name: string,
    body: Buffer | undefined,
  ) {
    const judged = verdict(await finder.byName(name), `sandbox "${name}"`);
    if (judged.kind === 'refuse') return refuse(reply, judged);
    if (judged.kind === 'none') {
      return reply
        .code(404)
        .send({ message: `no sandbox named "${name}" — acquire it first` });
    }
    const { node, id } = judged;
    return forwarded(request, reply, ' — retry', async () => {
      const status = await forwardStream(request.raw, reply.raw, {
        target: { endpoint: node.endpoint, token },
        credential: 'bearer',
        body,
      });
      if (status === 404) {
        void finder.verify({ id, name, nodeId: node.id });
      }
    });
  }
};

/**
 * The one field the gateway reads from a native body, judged by the wire's
 * own rule (shared sandboxNameSchema — what lookupSandbox validates
 * against) so no node is ever asked a question it would refuse: a node's
 * 400 to the lookup reads as silence, and the caller would get a 503 with
 * Retry-After for a name that can never be valid (found by review,
 * 2026-09-14).
 */
export function nameOf(
  body: Buffer | undefined,
): { name: string } | { refusal: string } {
  const parsed = parseJson(body) as { name?: unknown } | undefined;
  if (parsed?.name === undefined) {
    return { refusal: 'name is required and must be a string' };
  }
  const judged = sandboxNameSchema.safeParse(parsed.name);
  return judged.success
    ? { name: judged.data }
    : {
        refusal: `invalid name: ${judged.error.issues[0]?.message ?? 'refused by the wire'}`,
      };
}
