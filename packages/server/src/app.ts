import http from 'node:http';
import fastifyCookie from '@fastify/cookie';
import fastify, { type FastifyError, type FastifyServerFactory } from 'fastify';
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
import { ProcessTable } from './e2b/process-table';
import { WatcherTable } from './e2b/watcher-table';
import type { Executor } from './executor/executor';
import type { KeyedQueue } from './keyed-queue';
import { consoleRoutes } from './routes/console';
import { hostRoutes } from './routes/host';
import { sandboxRoutes } from './routes/sandboxes';
import { templateRoutes } from './routes/templates';
import { createSandboxProxy } from './sandbox-proxy';

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
   * layout, tests inject a fixture. Absent means /console answers an
   * honest 404.
   */
  consoleDistDir?: string;
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
  consoleDistDir,
}: AppDeps) {
  // Always a pino instance (booleans are normalized into one): two fastify()
  // call shapes would give the instance two different types.
  const loggerInstance =
    typeof logger === 'boolean' ? pino({ enabled: logger }) : logger;
  // The sandbox port proxy sits in front of routing — it triages by Host
  // header, so it must see the request before Fastify's router 404s a
  // wildcard host's arbitrary path. Only with the domain knob set; without
  // it the server is stock Fastify, byte for byte. app.inject() bypasses
  // the factory, so the proxy is exercised over real sockets only.
  let serverFactory: FastifyServerFactory | undefined;
  if (config.DORMICE_SANDBOX_DOMAIN) {
    const proxy = createSandboxProxy({ config, db, executor, locks });
    serverFactory = (handler) => {
      const server = http.createServer((req, res) => {
        if (proxy.matches(req)) proxy.handleRequest(req, res);
        else handler(req, res);
      });
      // Fastify itself never handles upgrades; sandbox WebSockets (dev
      // servers' HMR, notebooks) are the proxy's, everything else is cut.
      server.on('upgrade', (req, socket, head) => {
        if (proxy.matches(req)) proxy.handleUpgrade(req, socket, head);
        else socket.destroy();
      });
      return server;
    };
  }
  const app = fastify({
    loggerInstance,
    ...(serverFactory ? { serverFactory } : {}),
  }).withTypeProvider<ZodTypeProvider>();
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
  // cookie on the native routes, the /console surface mints and clears it.
  app.register(fastifyCookie);

  app.register(async (api) => {
    api.addHook('onRequest', requireApiAuth(config.DORMICE_API_TOKEN));
    await api.register(sandboxRoutes, { config, db, executor, locks });
    await api.register(templateRoutes, { db });
    await api.register(hostRoutes, { config, db, executor });
  });

  // The web console: session endpoints (open — login carries the token
  // itself) and the static SPA. Its API calls go through the routes above.
  app.register(async (scope) => {
    await scope.register(consoleRoutes, { config, consoleDistDir });
  });

  // The E2B compatibility surface lives beside the native API with its own
  // auth (X-API-KEY / X-Access-Token) and its own error dialect. The process
  // and watcher tables are per-daemon state, born with the app and gone
  // with it — a restart honestly empties them.
  const processes = new ProcessTable();
  const watchers = new WatcherTable();
  app.register(async (compat) => {
    await registerE2bCompat(compat, {
      config,
      db,
      executor,
      locks,
      processes,
      watchers,
    });
  });

  return app;
}
