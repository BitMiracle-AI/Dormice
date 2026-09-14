import http from 'node:http';
import nodePath from 'node:path';
import { GATEWAY_ONLY_VERBS } from '@dormice/shared';
import fastify, { type FastifyError, type FastifyServerFactory } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { type Logger, pino } from 'pino';
import { z } from 'zod';
import type { Archiver } from './archive/archiver';
import { requireApiAuth, tokensEqual } from './auth';
import type { Config } from './config';
import type { Db } from './db/db';
import { getOrCreateSigningSecret } from './db/secrets';
import { registerE2bCompat } from './e2b';
import { ProcessTable } from './e2b/process-table';
import { WatcherTable } from './e2b/watcher-table';
import type { Executor } from './executor/executor';
import type { KeyedQueue } from './keyed-queue';
import { envdTokenRoutes } from './routes/envd-token';
import { hostRoutes } from './routes/host';
import { lookupRoutes } from './routes/lookup';
import { sandboxRoutes } from './routes/sandboxes';
import { templateUsersRoutes } from './routes/template-users';
import { upgradeRoutes } from './routes/upgrade';
import { createSandboxProxy } from './sandbox-proxy';
import { Updater } from './updater';
import { readBuildInfo } from './version';

export interface AppDeps {
  config: Config;
  /** The ledger, holding a configuration copy (db/settings.ts applyNodeConfig) — main.ts waits for one before building the app; tests apply one. */
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
  /** Tests may inspect the one daemon-wide watcher registry. */
  watchers?: WatcherTable;
  /**
   * The archive/restore engine. Whether archiving is AVAILABLE is not its
   * presence but its enabled() — a live read of the copy's S3 settings,
   * so a bundle that turns archiving on applies without a restart.
   * Optional purely as a test convenience: many app tests exercise no
   * archive path, and to them an absent archiver equals a disabled one
   * (both make archiveEnabled(db) the sole adjudicator refuse).
   */
  archiver?: Archiver;
  /**
   * The daemon's own upgrade window. main.ts injects one that knows the
   * checkout the daemon runs from; the default knows no checkout, so
   * checkUpgrade answers an honest checkError instead of comparing (or
   * fetching over) whatever repository the process happens to sit in —
   * tests must never reach the network by accident.
   */
  updater?: Updater;
}

/**
 * Builds the Fastify instance with zod wired in as validator and serializer:
 * route schemas are plain zod schemas (the same ones @dormice/shared
 * exports), so request validation, TypeScript types and — later — OpenAPI
 * docs all derive from a single definition.
 *
 * The node's face (design record #22, 2026-09-14): the sandbox verbs, the
 * host's observation verbs, its own upgrade, and the two read-only
 * questions its gateway asks on its own account (lookupSandbox,
 * templateUsers) — behind one credential, the fleet token. Everything
 * that configures the fleet (settings, templates, API keys, domains, the
 * console and its sessions) is the gateway's; a key a caller presents is
 * judged there, and toward this node the gateway speaks the fleet token.
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
  watchers = new WatcherTable(),
  archiver,
  updater = new Updater({
    repoDir: null,
    build: readBuildInfo(),
    statusDir: nodePath.join(config.DORMICE_DATA_DIR, 'upgrade'),
    executor: config.DORMICE_EXECUTOR,
  }),
}: AppDeps) {
  // Always a pino instance (booleans are normalized into one): two fastify()
  // call shapes would give the instance two different types.
  const loggerInstance =
    typeof logger === 'boolean' ? pino({ enabled: logger }) : logger;
  // Process and watcher tables are per-daemon state. The watcher table is
  // also the single deferred-cleanup registry every wake path consults.
  const processes = new ProcessTable();

  // The sandbox port proxy sits in front of routing — it triages by Host
  // header, so it must see the request before Fastify's router 404s a
  // wildcard host's arbitrary path. Mounted unconditionally: the domain is
  // a live setting of the copy, so the proxy must already be in the path
  // when a bundle sets one — with no domain in force, matches() is
  // constantly false and the upgrade hook destroys non-matching sockets
  // exactly as stock Fastify (which never handles upgrades) would.
  // app.inject() bypasses the factory, so the proxy is exercised over real
  // sockets only.
  const proxy = createSandboxProxy({ db, executor, locks, watchers });
  const serverFactory: FastifyServerFactory = (handler) => {
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
  const app = fastify({
    loggerInstance,
    serverFactory,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // The long-lived streams — attached process streams, streaming WatchDir
  // requests — never end on their own, and Fastify's close waits for every
  // in-flight request. preClose ends them first, each with an honest
  // `unavailable` end-frame (retry after the restart — not `internal`,
  // which says something broke), bounded: a client that has stopped
  // reading cannot hold the restart. The processes themselves are not
  // signaled — they keep running in the sandbox, as they would across any
  // daemon restart; the watchers are stopped, and not resumed. What
  // is still open afterwards (a native execCommand mid-run, a proxied
  // request, an upgraded WebSocket) is the caller's business in main.ts,
  // which cuts the sockets when its grace period ends.
  app.addHook('preClose', async () => {
    await Promise.all([processes.shutdown(), watchers.shutdown()]);
  });

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
  // A verb that answers at the gateway alone, asked of a node: the 404
  // names the door. The emergency path is ssh to a node and curl its
  // loopback with the fleet token, and an operator on it asking for the
  // keys or the settings should be sent to where they live, not left
  // with a plain "not found" (shared GATEWAY_ONLY_VERBS; the console too,
  // which a node has not served since the second cut).
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    const atGateway =
      (GATEWAY_ONLY_VERBS as readonly string[]).includes(path.slice(1)) ||
      path === '/console' ||
      path.startsWith('/console/');
    reply.code(404).send({
      message: atGateway
        ? `${path} answers at the gateway (${config.DORMICE_GATEWAY_ENDPOINT}), not on a node`
        : `route ${request.method} ${request.url} not found`,
    });
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

  // The one adjudication of "does this bare credential open the door":
  // the fleet token, constant-time compared — the only credential a node
  // knows. Minted API keys are the gateway's to judge; it forwards under
  // this token. Both faces — the native Bearer header and the E2B
  // X-API-KEY hook — feed this same closure: one truth, two dialects. No
  // session leg: the console lives at the gateway, so no cookie is ever
  // valid here.
  const isCredential = (bare: string): boolean =>
    tokensEqual(bare, config.DORMICE_API_TOKEN);
  const apiAuth = requireApiAuth(isCredential, () => null);

  // The envd/signed-URL derivation base. Captured once — unlike a session
  // secret there is no verb that rotates it (see db/secrets.ts) — and NOT
  // the API token: the two credentials must rotate independently.
  const envdSigningSecret = getOrCreateSigningSecret(db);

  app.register(async (api) => {
    api.addHook('onRequest', apiAuth);
    await api.register(sandboxRoutes, {
      config,
      db,
      executor,
      locks,
      watchers,
      archiver,
    });
    await api.register(lookupRoutes, { db, locks, envdSigningSecret });
    await api.register(templateUsersRoutes, { db });
    await api.register(hostRoutes, { config, db, executor });
    await api.register(upgradeRoutes, { updater });
    await api.register(envdTokenRoutes, { envdSigningSecret });
  });

  // The E2B compatibility surface lives beside the native API with its own
  // auth (X-API-KEY / X-Access-Token) and its own error dialect.
  app.register(async (compat) => {
    await registerE2bCompat(compat, {
      config,
      db,
      executor,
      locks,
      processes,
      watchers,
      archiver,
      envdSigningSecret,
      isCredential,
    });
  });

  return app;
}
