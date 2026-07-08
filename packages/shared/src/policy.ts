import { z } from 'zod';

/**
 * Lifecycle policy: how long a sandbox may sit idle before the daemon moves
 * it one rung colder. All three thresholds count seconds since the sandbox's
 * last activity — they are points on the same clock, hence the ordering rule
 * freeze <= stop <= archive.
 *
 * Deliberately three flat fields and nothing more (no schedules, no policy
 * DSL): each knob answers one question — "how long until it gets colder".
 */
const lifecyclePolicyFields = z.object({
  /** Idle seconds until active → frozen. */
  freezeAfterSeconds: z.number().int().positive(),
  /**
   * Idle seconds until frozen → stopped. `null` means never stop: a
   * resident agent's sandbox parks frozen forever — memory in swap, ~50ms
   * from a wake — instead of decaying to a seconds-long cold boot.
   */
  stopAfterSeconds: z.number().int().positive().nullable(),
  /**
   * Idle seconds until stopped → archived. `null` means never archive —
   * the only valid value until the S3 archiver lands, and after that,
   * whenever the daemon has no S3 configured.
   */
  archiveAfterSeconds: z.number().int().positive().nullable(),
});

export const lifecyclePolicySchema = lifecyclePolicyFields
  .refine(
    (p) =>
      p.stopAfterSeconds === null || p.freezeAfterSeconds <= p.stopAfterSeconds,
    { message: 'freezeAfterSeconds must be <= stopAfterSeconds' },
  )
  .refine(
    (p) => p.archiveAfterSeconds === null || p.stopAfterSeconds !== null,
    {
      message:
        'archiveAfterSeconds requires a stopAfterSeconds — only a stopped sandbox can archive',
    },
  )
  .refine(
    (p) =>
      p.archiveAfterSeconds === null ||
      p.stopAfterSeconds === null ||
      p.stopAfterSeconds <= p.archiveAfterSeconds,
    { message: 'stopAfterSeconds must be <= archiveAfterSeconds' },
  );

export type LifecyclePolicy = z.infer<typeof lifecyclePolicySchema>;

/**
 * Per-sandbox override sent at acquire time. Every field optional; the daemon
 * merges it over the global defaults and validates the merged result with
 * `lifecyclePolicySchema` — that merged validation is the single arbiter,
 * so the override itself carries no ordering rule.
 */
export const lifecyclePolicyOverrideSchema = lifecyclePolicyFields.partial();

export type LifecyclePolicyOverride = z.infer<
  typeof lifecyclePolicyOverrideSchema
>;

/**
 * Zero-config experience: freeze fast, stop after a long weekend. Archiving
 * defaults to never — there is no archiver yet, and a default the daemon
 * cannot honor would be a standing lie in every response. When the S3
 * archiver lands, the default is adjudicated there, by whether S3 is
 * actually configured.
 */
export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = {
  freezeAfterSeconds: 10 * 60,
  stopAfterSeconds: 3 * 24 * 60 * 60,
  archiveAfterSeconds: null,
};
