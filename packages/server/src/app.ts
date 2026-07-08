import fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * Builds the Fastify instance with zod wired in as validator and serializer:
 * route schemas are plain zod schemas (the same ones @dormice/shared
 * exports), so request validation, TypeScript types and — later — OpenAPI
 * docs all derive from a single definition.
 *
 * Building the app is separate from listening so tests can inject requests
 * without opening a port.
 */
export function buildApp() {
  const app = fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

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

  return app;
}
