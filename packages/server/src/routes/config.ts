import { getConfigResponseSchema } from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { CONFIG_KEYS, type Config, type ConfigSources } from '../config';

export interface ConfigRoutesOptions {
  config: Config;
  sources: ConfigSources;
  /** buildApp's one adjudication of the archive default (null = no archiver). */
  archiveDefaultSeconds: number | null;
}

/**
 * The daemon's effective configuration, read-only: what is actually in
 * force, not what a config file says (doctor's discipline). Editing stays
 * on the host — /etc/dormice/env plus a restart — because a daemon that
 * rewrites its own environment is a different security decision entirely.
 * Secrets never cross the wire: set-or-unset is all anyone learns.
 */
export const configRoutes: FastifyPluginAsyncZod<ConfigRoutesOptions> = async (
  app,
  { config, sources, archiveDefaultSeconds },
) => {
  app.post(
    '/getConfig',
    {
      schema: {
        response: { 200: getConfigResponseSchema },
      },
    },
    async () => ({
      entries: (Object.keys(CONFIG_KEYS) as Array<keyof Config>).map((key) => {
        const { sensitive } = CONFIG_KEYS[key];
        const value = config[key];
        return {
          key,
          value: sensitive || value === undefined ? null : String(value),
          source: sources[key],
          ...(sensitive && value !== undefined ? { redacted: true } : {}),
        };
      }),
      archive: {
        enabled: archiveDefaultSeconds !== null,
        defaultSeconds: archiveDefaultSeconds,
      },
    }),
  );
};
