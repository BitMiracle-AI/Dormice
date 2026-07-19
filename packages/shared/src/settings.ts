import { z } from 'zod';
import { lifecyclePolicySchema } from './policy';

/**
 * Runtime settings — the operator knobs that live in the ledger, not the
 * environment. The dividing line (2026-07-19): a knob belongs here exactly
 * when changing it is an operations decision that must not require shell
 * access and a restart (capacity, what new sandboxes get); it stays an env
 * variable when changing it makes a different daemon (port, token,
 * executor, data dir, domain).
 *
 * The env variables of the same names still exist — as first-boot seeds
 * only. Once the ledger row exists, the ledger is the single truth and a
 * later env edit is deliberately ignored: two live sources for one knob is
 * a standing ambiguity, and the ledger is the daemon's one writable truth.
 */
export const sandboxResourceDefaultsSchema = z.object({
  /** CPU allowance per sandbox. Applies to every container launched after the change. */
  cpus: z.number().positive(),
  /** Memory cap per sandbox, GiB. Same launch-time application as cpus. */
  memoryGb: z.number().positive(),
  /**
   * Nominal disk size per sandbox, GiB. Consulted only when a disk is born
   * (first create, restore-from-archive) — an existing sandbox's disk never
   * resizes, because the disk is the sandbox's body.
   */
  diskGb: z.number().positive(),
});

export type SandboxResourceDefaults = z.infer<
  typeof sandboxResourceDefaultsSchema
>;

export const runtimeSettingsSchema = z.object({
  /** How many sandboxes may exist at once; past it, creation answers 429. Wakes are never blocked. */
  maxSandboxes: z.number().int().positive(),
  sandboxDefaults: sandboxResourceDefaultsSchema,
  /** What acquire() gives a sandbox that asks for nothing. Existing sandboxes keep theirs. */
  defaultPolicy: lifecyclePolicySchema,
  /**
   * Total daemon-managed swap, GiB, held as swapfiles on the data dir —
   * ON TOP of whatever swap the host already has (the install-time
   * swapfile stays fstab's business; the two never fight). Swap capacity
   * is roughly "how much sandbox memory can hibernate at once" — freezing
   * squeezes a sandbox's memory into swap. Growing takes effect
   * immediately; shrinking is deferred to the next host reboot, because
   * swapoff would drag every frozen sandbox's memory back into RAM
   * (getConfig's `swap.activeGb` reports what is actually mounted).
   * 0 = manage none. Ignored on hosts that cannot swap (see getConfig's
   * `swap.supported`), where updateSettings refuses to set it.
   */
  swapGb: z.number().int().nonnegative(),
  /** ISO 8601 of the last updateSettings; null = still exactly the first-boot seed. */
  updatedAt: z.string().nullable(),
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

/**
 * updateSettings(patch) — every provided group replaces that group whole
 * (the updatePolicy doctrine: what the form shows is what gets written, no
 * field-level merge ambiguity); absent groups stay untouched. At least one
 * group must be present — an empty patch is a caller confusion, not a no-op.
 */
export const updateSettingsRequestSchema = z
  .object({
    maxSandboxes: z.number().int().positive().optional(),
    sandboxDefaults: sandboxResourceDefaultsSchema.optional(),
    defaultPolicy: lifecyclePolicySchema.optional(),
    swapGb: z.number().int().nonnegative().optional(),
  })
  .refine(
    (patch) =>
      patch.maxSandboxes !== undefined ||
      patch.sandboxDefaults !== undefined ||
      patch.defaultPolicy !== undefined ||
      patch.swapGb !== undefined,
    {
      message:
        'updateSettings needs at least one of maxSandboxes, sandboxDefaults, defaultPolicy, swapGb',
    },
  );

export type UpdateSettingsRequest = z.input<typeof updateSettingsRequestSchema>;

export const updateSettingsResponseSchema = z.object({
  settings: runtimeSettingsSchema,
});

export type UpdateSettingsResponse = z.infer<
  typeof updateSettingsResponseSchema
>;
