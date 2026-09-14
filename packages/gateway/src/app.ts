import http from 'node:http';
import type { KeyedQueue } from '@dormice/server/keyed-queue';
import fastifyCookie from '@fastify/cookie';
import fastify, { type FastifyError, type FastifyServerFactory } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { type Logger, pino } from 'pino';
import { z } from 'zod';
import { requireAdminAuth, requireApiAuth, tokensEqual } from './auth';
import { classify, isOriginForm } from './classify';
import { type Config, type ConfigSources, configSources } from './config';
import { getConsoleAccount } from './db/account';
import { isLiveApiKey, verifyApiKeyToken } from './db/api-keys';
import type { Db } from './db/db';
import { renderError } from './errors';
import type { Finder } from './find';
import type { Fleet } from './fleet';
import type { Ingress } from './ingress';
import { type AskVerb, httpAsk } from './lookup';
import type { PlacementKnobs } from './placement';
import { createRawFaces } from './raw';
import { apiKeyRoutes } from './routes/api-keys';
import { consoleRoutes } from './routes/console';
import { e2bControlRoutes } from './routes/e2b';
import { envdTokenRoutes } from './routes/envd-token';
import { ingressRoutes } from './routes/ingress';
import { nativeRoutes } from './routes/native';
import { checkInRoutes, nodeRoutes } from './routes/nodes';
import { settingsRoutes } from './routes/settings';
import { templateRoutes } from './routes/templates';
import { type BuildInfo, readBuildInfo } from './version';

export interface GatewayAppDeps {
  config: Config;
  /** The gateway's own tables (db/schema.ts); ensureSettings has run on it. */
  db: Db;
  fleet: Fleet;
  finder: Finder;
  /** One queue for the whole gateway: the create and destroy verbs of both faces share per-name slots. */
  locks: KeyedQueue;
  /** A pino instance, or a boolean for the default logger (false = silent, for tests). */
  logger?: Logger | boolean;
  /** The build identity /healthz reports; null when built outside a checkout. */
  build?: BuildInfo | null;
  /**
   * Where the built web console lives; main.ts resolves the monorepo
   * layout, tests inject a fixture. Absent means /console answers an
   * honest 404.
   */
  consoleDistDir?: string;
  /**
   * The managed reverse-proxy front door, present exactly when
   * DORMICE_INGRESS_FILE is set. Absent, getIngress answers
   * { managed: false } and setIngress refuses.
   */
  ingress?: Ingress;
  /** Test seam over updateSettings' S3 round-trip probe; production probes for real. */
  probeS3?: SettingsProbe;
  /**
   * How the gateway asks a node a verb on its own account (removeTemplate's
   * templateUsers). Defaults to HTTP under the fleet token; tests script it.
   */
  ask?: AskVerb;
  /**
   * Which knobs came from the environment versus defaults, for getConfig.
   * Defaults to reading process.env; tests inject a fixed map.
   */
  sources?: ConfigSources;
}

type SettingsProbe = NonNullable<
  Parameters<typeof settingsRoutes>[1]['probeS3']
>;

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
 *
 * Three gates, three answers to "who may call" (design records #9, #20,
 * #22): the nodes' own gate (the fleet token and nothing else — a node
 * checking in is a machine, not a person or a client); the sandbox gate
 * (the fleet token, any live key the gateway minted, or the console's
 * session — everything that addresses a sandbox); and the admin gate (the
 * fleet token or the console session only — everything that configures
 * the fleet: keys, settings, templates, domains, nodes). A live key at the
 * admin gate gets an honest 403 naming the rule. Toward the nodes the
 * gateway always speaks the fleet token (forward.ts): the node trusts the
 * door whole.
 */
export function buildGatewayApp({
  config,
  db,
  fleet,
  finder,
  locks,
  logger = true,
  build = readBuildInfo(),
  consoleDistDir,
  ingress,
  probeS3,
  ask,
  sources = configSources(),
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

  // Cookie parsing app-wide: the two gates read the console's session
  // cookie, the /console surface mints and clears it.
  app.register(fastifyCookie);

  // The one adjudication of "does this bare credential open the sandbox
  // door": the fleet token (constant-time compare — the bootstrap
  // credential, always valid) or any live key the gateway minted (sha256
  // indexed lookup, judged per request so a mint or revoke takes effect on
  // the very next call). Both faces — the native Bearer header and the
  // E2B X-API-KEY hook — feed this same closure: one truth, two dialects.
  const isCredential = (bare: string): boolean =>
    tokensEqual(bare, token) || verifyApiKeyToken(db, bare) !== null;
  const isFleetToken = (bare: string): boolean => tokensEqual(bare, token);
  // Read per request: setup can replace the account (and void its
  // sessions) while the gateway runs.
  const sessionSecret = () => getConsoleAccount(db)?.sessionSecret ?? null;
  const apiAuth = requireApiAuth(isCredential, sessionSecret);
  const adminAuth = requireAdminAuth(
    isFleetToken,
    (bare) => isLiveApiKey(db, bare),
    sessionSecret,
  );

  const knobs = placementKnobs(config);

  // The nodes' gate: the fleet token alone. A key or a session is a
  // caller's credential, and a check-in is not a call — it is a machine
  // reporting; a node presenting anything else is misconfigured.
  app.register(async (nodesFace) => {
    nodesFace.addHook('onRequest', async (request, reply) => {
      const header = request.headers.authorization;
      const bare = header?.startsWith('Bearer ') ? header.slice(7) : null;
      if (bare === null || !isFleetToken(bare)) {
        await reply.code(401).send({ message: 'missing or invalid API token' });
      }
    });
    await nodesFace.register(checkInRoutes, { fleet, db });
  });

  // The sandbox gate: everything that addresses a sandbox.
  app.register(async (api) => {
    api.addHook('onRequest', apiAuth);
    await api.register(envdTokenRoutes, { finder, token });
    // Its own sub-scope: the byte-preserving body parser it installs must
    // not reach the gateway's own verbs, which keep Fastify's JSON parsing.
    await api.register(nativeRoutes, { fleet, finder, locks, knobs, token });
  });

  // The admin gate: everything that configures the fleet.
  app.register(async (admin) => {
    admin.addHook('onRequest', adminAuth);
    await admin.register(apiKeyRoutes, { db });
    await admin.register(nodeRoutes, { fleet, cache: finder.cache });
    await admin.register(settingsRoutes, {
      config,
      db,
      fleet,
      sources,
      ...(probeS3 ? { probeS3 } : {}),
    });
    await admin.register(templateRoutes, {
      db,
      fleet,
      ask: ask ?? httpAsk(token),
    });
    await admin.register(ingressRoutes, { ingress });
  });

  // The web console: account + session endpoints (open — setup and login
  // carry the credentials themselves) and the static SPA. Its API calls go
  // through the gates above.
  app.register(async (scope) => {
    await scope.register(consoleRoutes, { config, db, consoleDistDir });
  });

  // The E2B control plane, its own auth and dialect, like the daemon's.
  app.register(e2bControlRoutes, {
    fleet,
    finder,
    locks,
    knobs,
    token,
    isCredential,
    prefix: '/e2b/api',
  });

  return app;
}
