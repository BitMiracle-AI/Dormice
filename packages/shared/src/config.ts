import { z } from 'zod';
import { runtimeSettingsSchema } from './settings';

/**
 * getConfig() — the daemon's effective configuration: every env knob with
 * the value actually in force and where it came from, plus the runtime
 * settings that live in the ledger (see settings.ts — for those knobs the
 * env entries below are first-boot seeds, and `settings` is what is in
 * force). The same discipline as doctor: report effective values, never
 * parrot a config file. Secrets are reported as present-or-absent only —
 * their value never crosses the wire, whoever asks.
 */
export const configEntrySchema = z.object({
  /** The environment variable name, e.g. DORMICE_PORT. */
  key: z.string(),
  /**
   * Effective value, stringified. Null when the knob is unset (optional
   * knobs without a default) or when the entry is redacted.
   */
  value: z.string().nullable(),
  /** Explicitly set in the environment, or the built-in default. */
  source: z.enum(['env', 'default']),
  /** True on secrets that are set: presence reported, value withheld. */
  redacted: z.boolean().optional(),
});

export type ConfigEntry = z.infer<typeof configEntrySchema>;

export const getConfigResponseSchema = z.object({
  entries: z.array(configEntrySchema),
  /**
   * The daemon's one adjudication of "is archiving available" (the whole
   * DORMICE_S3_* set configured), plus the default distance from stopped
   * to archived that new sandboxes get. Clients gate archive knobs on
   * this instead of re-deriving it from the S3 entries.
   */
  archive: z.object({
    enabled: z.boolean(),
    /**
     * Null when disabled (a promise nobody can honor is never made) — and
     * also when the operator set the default policy to never archive.
     */
    defaultSeconds: z.number().int().nullable(),
  }),
  /** The ledger-resident operator knobs actually in force — see settings.ts. */
  settings: runtimeSettingsSchema,
});

export type GetConfigResponse = z.infer<typeof getConfigResponseSchema>;
