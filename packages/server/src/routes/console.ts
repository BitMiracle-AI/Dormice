import fastifyStatic from '@fastify/static';
import type { FastifyReply, onRequestAsyncHookHandler } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  hashPassword,
  mintSession,
  mintSessionSecret,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  tokensEqual,
  verifyPassword,
} from '../auth';
import type { Config } from '../config';
import { getConsoleAccount, setConsoleAccount } from '../db/account';
import type { Db } from '../db/db';
import { mintEnvdToken } from '../e2b/protocol';
import { LoginThrottle } from '../login-throttle';

export interface ConsoleRoutesOptions {
  config: Config;
  db: Db;
  /** The API-wide auth arbiter, built once in app.ts — one truth. */
  apiAuth: onRequestAsyncHookHandler;
  /**
   * Where the built web console lives (packages/console/dist). Injected so
   * tests point it at a fixture and embedders can omit it; absent means
   * /console answers an honest 404 instead of guessing at paths.
   */
  consoleDistDir?: string;
  /**
   * HMAC key for the envd tokens this surface mints — the ledger's signing
   * secret, never the API token (they rotate independently).
   */
  envdSigningSecret: string;
}

// No Secure flag: the daemon speaks plain http on 127.0.0.1 by design, and
// behind a TLS reverse proxy the browser-facing side is the proxy's job.
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict',
  path: '/',
} as const;

const messageResponse = z.object({ message: z.string() });

/**
 * The web console's own surface: account + session endpoints and the static
 * SPA. Everything else the console does goes through the native RPC routes
 * with the session cookie — same routes, same truth as the SDK and CLI.
 *
 * The credential model: the API token is the root of trust (machine
 * credential, lives in server env), the account is the human convenience
 * derived from it. Setup requires the token and overwrites the account —
 * first-run initialization, password change and forgot-password are all
 * that one verb, so there is no registration race (an open "first visitor
 * becomes admin" door on a public URL) and no recovery flow to build.
 */
export const consoleRoutes: FastifyPluginAsyncZod<
  ConsoleRoutesOptions
> = async (app, { config, db, apiAuth, consoleDistDir, envdSigningSecret }) => {
  // Per-app, not module-global: each daemon (and each test app) gets its
  // own counters. Shared by login and setup — both are credential guesses.
  const throttle = new LoginThrottle();

  const setSessionCookie = (reply: FastifyReply, sessionSecret: string) => {
    reply.setCookie(SESSION_COOKIE, mintSession(sessionSecret), {
      ...COOKIE_OPTIONS,
      // The cookie lives exactly as long as the HMAC inside it is valid.
      maxAge: SESSION_TTL_SECONDS,
    });
  };

  // Open by design: it answers only "is setup still pending", which the
  // login page needs before any credential exists. An attacker learns
  // nothing usable — completing setup requires the API token either way.
  app.post(
    '/console/auth/status',
    {
      schema: {
        response: { 200: z.object({ accountExists: z.boolean() }) },
      },
    },
    async () => ({ accountExists: getConsoleAccount(db) !== undefined }),
  );

  app.post(
    '/console/auth/setup',
    {
      schema: {
        body: z.object({
          token: z.string().min(1),
          username: z.string().trim().min(1).max(64),
          // Length is the only strength rule: composition rules push people
          // toward Password1! and help nobody.
          password: z.string().min(8).max(128),
        }),
        response: {
          200: z.object({ loggedIn: z.literal(true) }),
          401: messageResponse,
          429: messageResponse,
        },
      },
    },
    async (request, reply) => {
      const wait = throttle.retryAfterSeconds(request.ip);
      if (wait > 0) {
        return reply.code(429).send({
          message: `too many failed attempts — retry in ${wait}s`,
        });
      }
      if (!tokensEqual(request.body.token, config.DORMICE_API_TOKEN)) {
        throttle.recordFailure(request.ip);
        return reply.code(401).send({ message: 'invalid API token' });
      }
      throttle.clear(request.ip);
      const account = setConsoleAccount(db, {
        username: request.body.username,
        passwordHash: await hashPassword(request.body.password),
        // A fresh secret voids every existing session — the semantics a
        // password (re)set should have.
        sessionSecret: mintSessionSecret(),
      });
      setSessionCookie(reply, account.sessionSecret);
      return { loggedIn: true as const };
    },
  );

  app.post(
    '/console/auth/login',
    {
      schema: {
        // min(1) only: the password policy is enforced where passwords are
        // set; login must accept whatever was stored.
        body: z.object({
          username: z.string().min(1),
          password: z.string().min(1),
        }),
        response: {
          200: z.object({ loggedIn: z.literal(true) }),
          401: messageResponse,
          409: messageResponse,
          429: messageResponse,
        },
      },
    },
    async (request, reply) => {
      const wait = throttle.retryAfterSeconds(request.ip);
      if (wait > 0) {
        return reply.code(429).send({
          message: `too many failed attempts — retry in ${wait}s`,
        });
      }
      const account = getConsoleAccount(db);
      if (!account) {
        // Not a failed guess (nothing exists to guess at), so no throttle
        // hit — an honest pointer to setup instead.
        return reply.code(409).send({
          message: 'no account exists yet — complete setup with the API token',
        });
      }
      // Evaluate both factors unconditionally so a wrong username costs the
      // same time as a wrong password.
      const usernameOk = tokensEqual(request.body.username, account.username);
      const passwordOk = await verifyPassword(
        request.body.password,
        account.passwordHash,
      );
      if (!usernameOk || !passwordOk) {
        throttle.recordFailure(request.ip);
        return reply
          .code(401)
          .send({ message: 'invalid username or password' });
      }
      throttle.clear(request.ip);
      setSessionCookie(reply, account.sessionSecret);
      return { loggedIn: true as const };
    },
  );

  app.post(
    '/console/auth/logout',
    {
      schema: {
        response: { 200: z.object({ loggedIn: z.literal(false) }) },
      },
    },
    async (_request, reply) => {
      reply.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
      return { loggedIn: false as const };
    },
  );

  // The console's terminal speaks to the envd surface directly — the same
  // wire the e2b SDK uses — but envd auth is the per-sandbox HMAC keyed by
  // the daemon's signing secret, which never leaves the daemon and the
  // browser deliberately never holds. This trades the session for exactly
  // one sandbox's token; the API-wide arbiter guards it, so the cookie path
  // also needs the console header. Minting is stateless on purpose (like
  // the secret itself): a made-up sandboxId yields a token that opens
  // nothing.
  app.post(
    '/console/envdToken',
    {
      onRequest: apiAuth,
      schema: {
        body: z.object({ sandboxId: z.string().min(1) }),
        response: {
          200: z.object({ envdAccessToken: z.string() }),
        },
      },
    },
    async (request) => ({
      envdAccessToken: mintEnvdToken(envdSigningSecret, request.body.sandboxId),
    }),
  );

  // The bare-origin convenience: a browser landing on / is a human looking
  // for the console — send them there (even unbuilt, /console's "run pnpm
  // build" 404 beats "route not found"). Machines never GET / with an html
  // Accept, so they keep the honest 404 from the app-wide arbiter.
  app.get('/', async (request, reply) => {
    if (request.headers.accept?.includes('text/html')) {
      return reply.redirect('/console/');
    }
    return reply.callNotFound();
  });

  if (consoleDistDir) {
    await app.register(
      async (scope) => {
        await scope.register(fastifyStatic, { root: consoleDistDir });
        // SPA fallback: the router owns paths under /console, so any GET
        // that matches no file is a client-side route — serve the app and
        // let it resolve. Everything else keeps the honest 404.
        scope.setNotFoundHandler((request, reply) => {
          if (request.method === 'GET') {
            return reply.sendFile('index.html');
          }
          reply.code(404).send({
            message: `route ${request.method} ${request.url} not found`,
          });
        });
      },
      { prefix: '/console' },
    );
  } else {
    app.get('/console', async (_request, reply) =>
      reply.code(404).send({
        message:
          'web console not available: packages/console/dist was not found at startup — run `pnpm build` first',
      }),
    );
  }
};
