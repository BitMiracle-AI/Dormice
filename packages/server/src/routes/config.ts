import { getConfigResponseSchema } from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { CONFIG_KEYS, type Config, type ConfigSources } from '../config';
import type { Db } from '../db/db';
import { readRuntimeSettings } from '../db/settings';
import type { SwapControl } from '../swap';

export interface ConfigRoutesOptions {
  config: Config;
  db: Db;
  sources: ConfigSources;
  /** buildApp's one adjudication of the archive default (null = no archiver). */
  archiveDefaultSeconds: number | null;
  /** The managed-swap surface; absent = this host cannot manage swap. */
  swap?: SwapControl;
}

/**
 * The daemon's effective configuration: the env knobs (read-only — editing
 * those stays on the host, /etc/dormice/env plus a restart, because a
 * daemon that rewrites its own environment is a different security
 * decision entirely) plus the ledger-resident runtime settings, which DO
 * have a write verb (updateSettings, admin scope). For the knobs that
 * moved into the ledger the env entries below are first-boot seeds;
 * `settings` is what is in force. Secrets never cross the wire: set-or-
 * unset is all anyone learns.
 */
export const configRoutes: FastifyPluginAsyncZod<ConfigRoutesOptions> = async (
  app,
  { config, db, sources, archiveDefaultSeconds, swap },
) => {
  app.post(
    '/getConfig',
    {
      schema: {
        response: { 200: getConfigResponseSchema },
      },
    },
    async () => {
      const settings = readRuntimeSettings(db);
      return {
        entries: (Object.keys(CONFIG_KEYS) as Array<keyof Config>).map(
          (key) => {
            const { sensitive } = CONFIG_KEYS[key];
            const value = config[key];
            return {
              key,
              value: sensitive || value === undefined ? null : String(value),
              source: sources[key],
              ...(sensitive && value !== undefined ? { redacted: true } : {}),
            };
          },
        ),
        archive: {
          enabled: archiveDefaultSeconds !== null,
          // What new sandboxes actually get is the ledger's default policy
          // — the boot constant is only its seed.
          defaultSeconds:
            archiveDefaultSeconds === null
              ? null
              : settings.defaultPolicy.archiveAfterSeconds,
        },
        // Read live so a pending shrink (target < mounted, waiting for a
        // host reboot) or a failed grow is visible, not papered over.
        swap: swap
          ? { supported: true, activeGb: (await swap.status()).activeGb }
          : { supported: false, activeGb: 0 },
        settings,
      };
    },
  );
};
