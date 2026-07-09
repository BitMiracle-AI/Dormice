import fastifyCookie from '@fastify/cookie';
import fastify, { type FastifyError } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { type Logger, pino } from 'pino';
import { z } from 'zod';
import { requireApiAuth } from './auth';
import type { Config } from './config';
import type { Db } from './db/db';
import { registerE2bCompat } from './e2b';
import type { Executor } from './executor/executor';
import type { KeyedQueue } from './keyed-queue';
import { sandboxRoutes } from './routes/sandboxes';
import { uiRoutes } from './routes/ui';

export interface AppDeps {
  config: Config;
  db: Db;
  executor: Executor;
  /**
   * The per-sandbox serialization point, shared with the heartbeat's
   * scanner and reconciler — one instance for the whole daemon, or the
   * serialization silently splits into parallel universes.
   */
  locks: KeyedQueue;
  /**
   * Tests turn logging off with `false`; the daemon passes its own pino
   * instance, which it also hands to the executor — one logger, created
   * before anything that needs it.
   */
  logger?: boolean | Logger;
  /**
   * Where the built web console lives; main.ts resolves the monorepo
   * layout, tests inject a fixture. Absent means /ui answers an honest 404.
   */
  webDistDir?: string;
}

/**
 * Builds the Fastify instance with zod wired in as validator and serializer:
 * route schemas are plain zod schemas (the same ones @dormice/shared
 * exports), so request validation, TypeScript types and — later — OpenAPI
 * docs all derive from a single definition.
 *
 * Building the app is separate from listening so tests can inject requests
 * without opening a port.
 */
export function buildApp({
  config,
  db,
  executor,
  locks,
  logger = true,
  webDistDir,
}: AppDeps) {
  // Always a pino instance (booleans are normalized into one): two fastify()
  // call shapes would give the instance two different types.
  const loggerInstance =
    typeof logger === 'boolean' ? pino({ enabled: logger }) : logger;
  const app = fastify({ loggerInstance }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // The single arbiter for the wire's error shape: every non-2xx body is
  // { message }, whoever produced the error. Without this, Fastify's own
  // validation failures leak its native multi-field shape on routes that
  // declare no error schema — two error dialects on one API.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      // 4xx name the caller's mistake and are expected traffic; 5xx are ours.
      request.log.error(error, 'request failed');
    }
    reply.code(status).send({ message: error.message });
  });
  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send({ message: `route ${request.method} ${request.url} not found` });
  });

  // Liveness probe: open by design (probes have no secrets), everything
  // else lives behind the token.
  app.get(
    '/healthz',
    {
      schema: {
        response: {
          200: z.object({ status: z.literal('ok') }),
        },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  // Cookie parsing app-wide: the auth arbiter reads the console's session
  // cookie on the native routes, the /ui surface mints and clears it.
  app.register(fastifyCookie);

  app.register(async (api) => {
    api.addHook('onRequest', requireApiAuth(config.DORMICE_API_TOKEN));
    await api.register(sandboxRoutes, { config, db, executor, locks });
  });

  // The web console: session endpoints (open — login carries the token
  // itself) and the static SPA. Its API calls go through the routes above.
  app.register(async (ui) => {
    await ui.register(uiRoutes, { config, webDistDir });
  });

  // The E2B compatibility surface lives beside the native API with its own
  // auth (X-API-KEY / X-Access-Token) and its own error dialect.
  app.register(async (compat) => {
    await registerE2bCompat(compat, { config, db, executor, locks });
  });

  return app;
}
