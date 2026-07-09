import type { FastifyInstance } from 'fastify';
import { e2bControlRoutes } from './control';
import type { E2bDeps } from './deps';
import { e2bEnvdRoutes } from './envd';

/**
 * The E2B compatibility layer: the official `e2b` package connects with two
 * URLs — apiUrl -> <daemon>/e2b/api, sandboxUrl -> <daemon>/e2b/envd — plus
 * `e2b_<DORMICE_API_TOKEN>` as its API key. Both scopes carry their own
 * auth and their own { code, message } error dialect; the native API's
 * Bearer auth and { message } dialect stay outside, untouched.
 */
export async function registerE2bCompat(
  app: FastifyInstance,
  deps: E2bDeps,
): Promise<void> {
  await app.register(e2bControlRoutes, { ...deps, prefix: '/e2b/api' });
  await app.register(e2bEnvdRoutes, { ...deps, prefix: '/e2b/envd' });
}
