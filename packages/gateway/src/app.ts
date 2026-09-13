import http from 'node:http';
import { tokensEqual } from '@dormice/server/auth';
import type { KeyedQueue } from '@dormice/server/keyed-queue';
import fastify, { type FastifyError, type FastifyServerFactory } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { type Logger, pino } from 'pino';
import { z } from 'zod';
import { classify, isOriginForm } from './classify';
import type { Config } from './config';
import { renderError } from './errors';
import type { Finder } from './find';
import type { Fleet } from './fleet';
import type { PlacementKnobs } from './placement';
import { createRawFaces } from './raw';
import { e2bControlRoutes } from './routes/e2b';
import { nativeRoutes } from './routes/native';
import { nodeRoutes } from './routes/nodes';
import { type BuildInfo, readBuildInfo } from './version';

export interface GatewayAppDeps {
  config: Config;
  fleet: Fleet;
  finder: Finder;
  /** One queue for the whole gateway: the create and destroy verbs of both faces share per-name slots. */
  locks: KeyedQueue;
  /** A pino instance, or a boolean for the default logger (false = silent, for tests). */
  logger?: Logger | boolean;
  /** The build identity /healthz reports; null when built outside a checkout. */
  build?: BuildInfo | null;
}

/** Placement's knobs, read once from the config. */
export function placementKnobs(config: Config): PlacementKnobs {
  return {
    cpuLimitPct: config.DORMICE_GATEWAY_NODE_CPU_LIMIT_PCT,
    activeLimit: config.DORMICE_GATEWAY_NODE_ACTIVE_LIMIT,
    minDiskAvailableBytes: config.DORMICE_GATEWAY_NODE_MIN_DISK_GB * 2 ** 30,
  };
}

/**
 * Builds the gateway's Fastify instance — the daemon's shape (zod as
 * validator and serializer, one error dialect, /healthz open), without
 * the daemon's body. Building is separate from listening so tests inject
 * requests without a port; the raw faces need real sockets.
 */
export function buildGatewayApp({
  config,
  fleet,
  finder,
  locks,
  logger = true,
  build = readBuildInfo(),
}: GatewayAppDeps) {
  const loggerInstance =
    typeof logger === 'boolean' ? pino({ enabled: logger }) : logger;
  const token = config.DORMICE_API_TOKEN;

  // The face keyed on a header sits in front of Fastify, exactly as the
  // daemon's port proxy does (server/app.ts): refuse what is not an
  // origin-form target (classify.ts isOriginForm), triage the raw
  // request, hand the rest to Fastify. app.inject() bypasses the factory,
  // so that face is exercised over real sockets only.
  const raw = createRawFaces({ finder, token, log: loggerInstance });
  const serverFactory: FastifyServerFactory = (handler) => {
    const server = http.createServer((req, res) => {
      if (!isOriginForm(req)) {
        renderError(res, 'native', {
          status: 400,
          message:
            'request target must be origin-form (a path starting with "/")',
        });
        return;
      }
      const kind = classify(req);
      if (kind.face === 'fastify') handler(req, res);
      else raw.handleRequest(kind, req, res);
    });
    server.on('upgrade', (req, socket) => {
      raw.handleUpgrade(classify(req), req, socket);
    });
    // The gateway only relays; the node's own request timeout is the one
    // that should fire on a slow upload, not a second one in front of it.
    server.requestTimeout = 0;
    return server;
  };
  const app = fastify({
    loggerInstance,
    serverFactory,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // The native error dialect, verbatim from the daemon: every non-2xx body
  // the gateway itself produces is { message }. Errors a node produced are
  // forwarded as they came, in whichever dialect that face speaks.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error, 'request failed');
    }
    reply.code(status).send({ message: error.message });
  });
  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send({ message: `route ${request.method} ${request.url} not found` });
  });

  // Liveness, open by design; the build identity so an operator can tell
  // which commit answers without a token.
  app.get(
    '/healthz',
    {
      schema: {
        response: {
          200: z.object({
            status: z.literal('ok'),
            build: z
              .object({
                commit: z.string(),
                title: z.string(),
                committedAt: z.string(),
              })
              .nullable(),
          }),
        },
      },
    },
    async () => ({ status: 'ok' as const, build }),
  );

  // One credential opens the door: the fleet's token, presented as a
  // Bearer by callers and by nodes checking in alike. Keys minted by the
  // gateway — many, expiring, revocable — arrive with its key table.
  const knobs = placementKnobs(config);
  app.register(async (api) => {
    api.addHook('onRequest', async (request, reply) => {
      const header = request.headers.authorization;
      const bare = header?.startsWith('Bearer ') ? header.slice(7) : null;
      if (bare === null || !tokensEqual(bare, token)) {
        await reply.code(401).send({ message: 'missing or invalid API token' });
      }
    });
    await api.register(nodeRoutes, { fleet, cache: finder.cache });
    // Its own sub-scope: the byte-preserving body parser it installs must
    // not reach the gateway's own verbs, which keep Fastify's JSON parsing.
    await api.register(nativeRoutes, { fleet, finder, locks, knobs, token });
  });

  // The E2B control plane, its own auth and dialect, like the daemon's.
  app.register(e2bControlRoutes, {
    fleet,
    finder,
    locks,
    knobs,
    token,
    prefix: '/e2b/api',
  });

  return app;
}
