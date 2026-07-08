import fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireApiToken } from './auth';
import type { Config } from './config';
import type { Db } from './db/db';
import { sandboxRoutes } from './routes/sandboxes';

export interface AppDeps {
  config: Config;
  db: Db;
  /** Tests turn logging off; the daemon leaves it on. */
  logger?: boolean;
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
export function buildApp({ config, db, logger = true }: AppDeps) {
  const app = fastify({ logger }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

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

  app.register(async (api) => {
    api.addHook('onRequest', requireApiToken(config.DORMICE_API_TOKEN));
    await api.register(sandboxRoutes, { config, db });
  });

  return app;
}
