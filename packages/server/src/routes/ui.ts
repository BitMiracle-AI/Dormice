import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  mintSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  tokensEqual,
} from '../auth';
import type { Config } from '../config';

export interface UiRoutesOptions {
  config: Config;
  /**
   * Where the built web console lives (packages/web/dist). Injected so
   * tests point it at a fixture and embedders can omit it; absent means
   * /ui answers an honest 404 instead of guessing at paths.
   */
  webDistDir?: string;
}

// No Secure flag: the daemon speaks plain http on 127.0.0.1 by design, and
// behind a TLS reverse proxy the browser-facing side is the proxy's job.
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict',
  path: '/',
} as const;

/**
 * The web console's own surface: session endpoints and the static SPA.
 * Everything else the console does goes through the native RPC routes with
 * the session cookie — same routes, same truth as the SDK and CLI.
 */
export const uiRoutes: FastifyPluginAsyncZod<UiRoutesOptions> = async (
  app,
  { config, webDistDir },
) => {
  app.post(
    '/ui/auth/login',
    {
      schema: {
        body: z.object({ token: z.string() }),
        response: {
          200: z.object({ loggedIn: z.literal(true) }),
          401: z.object({ message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      if (!tokensEqual(request.body.token, config.DORMICE_API_TOKEN)) {
        return reply.code(401).send({ message: 'invalid API token' });
      }
      reply.setCookie(SESSION_COOKIE, mintSession(config.DORMICE_API_TOKEN), {
        ...COOKIE_OPTIONS,
        // The cookie lives exactly as long as the HMAC inside it is valid.
        maxAge: SESSION_TTL_SECONDS,
      });
      return { loggedIn: true as const };
    },
  );

  app.post(
    '/ui/auth/logout',
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

  if (webDistDir) {
    await app.register(
      async (ui) => {
        await ui.register(fastifyStatic, { root: webDistDir });
        // SPA fallback: the router owns paths under /ui, so any GET that
        // matches no file is a client-side route — serve the app and let
        // it resolve. Everything else keeps the honest 404.
        ui.setNotFoundHandler((request, reply) => {
          if (request.method === 'GET') {
            return reply.sendFile('index.html');
          }
          reply.code(404).send({
            message: `route ${request.method} ${request.url} not found`,
          });
        });
      },
      { prefix: '/ui' },
    );
  } else {
    app.get('/ui', async (_request, reply) =>
      reply.code(404).send({
        message:
          'web console not available: packages/web/dist was not found at startup — run `pnpm build` first',
      }),
    );
  }
};
