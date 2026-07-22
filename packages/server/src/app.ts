import http from 'node:http';
import nodePath from 'node:path';
import { apiKeyActor, ENV_TOKEN_ACTOR } from '@dormice/shared';
import fastifyCookie from '@fastify/cookie';
import fastify, { type FastifyError, type FastifyServerFactory } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { type Logger, pino } from 'pino';
import { z } from 'zod';
import type { Archiver } from './archive/archiver';
import { requireAdminAuth, requireApiAuth, tokensEqual } from './auth';
import { type Config, type ConfigSources, configSources } from './config';
import { getConsoleAccount } from './db/account';
import { isLiveApiKey, verifyApiKeyToken } from './db/api-keys';
import type { Db } from './db/db';
import { getOrCreateSigningSecret } from './db/secrets';
import { ensureRuntimeSettings } from './db/settings';
import { registerE2bCompat } from './e2b';
import { ProcessTable } from './e2b/process-table';
import { WatcherTable } from './e2b/watcher-table';
import type { Executor } from './executor/executor';
import type { Ingress } from './ingress';
import type { KeyedQueue } from './keyed-queue';
import { ARCHIVE_DEFAULT_SECONDS } from './policy';
import { activityRoutes } from './routes/activity';
import { apiKeyRoutes } from './routes/api-keys';
import { configRoutes } from './routes/config';
import { consoleRoutes } from './routes/console';
import { hostRoutes } from './routes/host';
import { ingressRoutes } from './routes/ingress';
import { sandboxRoutes } from './routes/sandboxes';
import { settingsRoutes } from './routes/settings';
import { templateRoutes } from './routes/templates';
import { upgradeRoutes } from './routes/upgrade';
import { createSandboxProxy } from './sandbox-proxy';
import type { SwapControl } from './swap';
import { Updater } from './updater';
import { readBuildInfo } from './version';

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
  /** Tests may inspect the one daemon-wide watcher registry. */
  watchers?: WatcherTable;
  /**
   * Where the built web console lives; main.ts resolves the monorepo
   * layout, tests inject a fixture. Absent means /console answers an
   * honest 404.
   */
  consoleDistDir?: string;
  /**
   * The archive/restore engine, present exactly when S3 is configured.
   * Absent, the daemon is byte-for-byte the archive-less daemon: the
   * scanner never moves the archive rung and archive-asking policies are
   * refused (the SANDBOX_DOMAIN precedent — an unconfigured feature is
   * honestly absent, never half-present).
   */
  archiver?: Archiver;
  /**
   * The managed reverse-proxy front door, present exactly when
   * DORMICE_INGRESS_FILE is set (same rule as the archiver). Absent,
   * getIngress answers { managed: false } and setIngress refuses.
   */
  ingress?: Ingress;
  /**
   * The managed-swap surface, present exactly when the daemon can manage
   * swap — main.ts builds one on Linux with the docker executor. Absent,
   * getConfig reports { supported: false } and a swapGb patch is refused.
   */
  swap?: SwapControl;
  /**
   * Which knobs came from the environment versus defaults, for getConfig.
   * Defaults to reading process.env — right for the daemon; tests that
   * assert on sources inject a fixed map instead of trusting the shell.
   */
  sources?: ConfigSources;
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
  consoleDistDir,
  archiver,
  ingress,
  swap,
  sources = configSources(),
  updater = new Updater({
    repoDir: null,
    build: readBuildInfo(),
    statusDir: nodePath.join(config.DORMICE_DATA_DIR, 'upgrade'),
    executor: config.DORMICE_EXECUTOR,
  }),
}: AppDeps) {
  // The archive default is adjudicated once, here, by the archiver's
  // presence: with one, new sandboxes archive after a week of idleness;
  // without one, never — and asking is a 400.
  const archiveDefaultSeconds = archiver ? ARCHIVE_DEFAULT_SECONDS : null;
  // Idempotent get-or-seed: main.ts already ran it (the executor reads
  // settings before buildApp), tests build the app directly and need it here.
  ensureRuntimeSettings(db, config, archiveDefaultSeconds);
  // Always a pino instance (booleans are normalized into one): two fastify()
  // call shapes would give the instance two different types.
  const loggerInstance =
    typeof logger === 'boolean' ? pino({ enabled: logger }) : logger;
  // Process and watcher tables are per-daemon state. The watcher table is
  // also the single deferred-cleanup registry every wake path consults.
  const processes = new ProcessTable();

  // The sandbox port proxy sits in front of routing — it triages by Host
  // header, so it must see the request before Fastify's router 404s a
  // wildcard host's arbitrary path. Only with the domain knob set; without
  // it the server is stock Fastify, byte for byte. app.inject() bypasses
  // the factory, so the proxy is exercised over real sockets only.
  let serverFactory: FastifyServerFactory | undefined;
  if (config.DORMICE_SANDBOX_DOMAIN) {
    const proxy = createSandboxProxy({ config, db, executor, locks, watchers });
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

  // Attribution rides the request from the auth hook that admitted it into
  // every recordActivity the handler reaches. Declared once so the property
  // shape is stable; null is what unauthenticated surfaces keep.
  app.decorateRequest('actor', null);

  // The one adjudication of "does this bare credential open the door" —
  // and of who it is (the two are the same act, so identity is captured
  // here, not re-derived later): the env token (constant-time compare —
  // the bootstrap credential, always valid) or any active ledger API key
  // (sha256 indexed lookup, judged per request so a mint or revoke takes
  // effect on the very next call). Both faces — the native Bearer header
  // and the E2B X-API-KEY hook — feed this same closure: one truth, two
  // dialects.
  const identifyCredential = (bare: string): string | null => {
    if (tokensEqual(bare, config.DORMICE_API_TOKEN)) {
      return ENV_TOKEN_ACTOR;
    }
    const keyId = verifyApiKeyToken(db, bare);
    return keyId === null ? null : apiKeyActor(keyId);
  };

  // Built once, used by every guarded surface. The secret getter reads the
  // ledger per request because setup can replace the account (and void its
  // sessions) while the daemon runs — a captured value would keep dead
  // sessions alive until restart.
  const apiAuth = requireApiAuth(
    identifyCredential,
    () => getConsoleAccount(db)?.sessionSecret ?? null,
  );

  // The apiKey verbs are admin-only: a credential must not be able to
  // manage the credential ledger it lives in (key-manages-key is a
  // self-replication ladder for a leaked key). Env token or console
  // session only; a live ledger key gets an honest 403, not a silent 401.
  const adminAuth = requireAdminAuth(
    (bare) => tokensEqual(bare, config.DORMICE_API_TOKEN),
    (bare) => isLiveApiKey(db, bare),
    () => getConsoleAccount(db)?.sessionSecret ?? null,
  );

  // The envd/signed-URL derivation base. Captured once — unlike the session
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
      archiveDefaultSeconds,
    });
    await api.register(templateRoutes, { db });
    await api.register(hostRoutes, { config, db, executor });
    await api.register(activityRoutes, { db });
    await api.register(ingressRoutes, { db, ingress });
    await api.register(configRoutes, {
      config,
      db,
      sources,
      archiveDefaultSeconds,
      swap,
    });
    await api.register(upgradeRoutes, { updater, db });
  });

  // The apiKey management verbs and updateSettings sit behind the stricter
  // admin gate — their own scope, because a Fastify hook guards a whole
  // scope and these verbs share a different answer to "who may call":
  // credentials must not manage credentials, and a leaked automation key
  // must not be able to raise the very limits that contain it.
  app.register(async (admin) => {
    admin.addHook('onRequest', adminAuth);
    await admin.register(apiKeyRoutes, { db });
    await admin.register(settingsRoutes, {
      db,
      archiveEnabled: archiveDefaultSeconds !== null,
      swap,
    });
  });

  // The web console: account + session endpoints (open — setup and login
  // carry the credentials themselves) and the static SPA. Its API calls go
  // through the routes above.
  app.register(async (scope) => {
    await scope.register(consoleRoutes, {
      config,
      db,
      apiAuth,
      consoleDistDir,
      envdSigningSecret,
    });
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
      archiveDefaultSeconds,
      envdSigningSecret,
      identifyCredential,
    });
  });

  return app;
}
