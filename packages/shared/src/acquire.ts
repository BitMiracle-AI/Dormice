import { z } from 'zod';
import { lifecyclePolicyOverrideSchema } from './policy';
import { sandboxSchema, userKeySchema } from './sandbox';

/**
 * acquire(userKey) — the platform's single entry point. Idempotent:
 * no sandbox → create; frozen → wake; stopped → rebuild; archived → restore.
 */
export const acquireRequestSchema = z.object({
  userKey: userKeySchema,
  /**
   * Lifecycle override applied when this acquire creates the sandbox;
   * omitted fields fall back to the daemon's global defaults. When the key
   * already has a sandbox, the stored policy stays — acquire is not an
   * update verb — but an invalid override is still answered with a 400,
   * never silently ignored.
   */
  policy: lifecyclePolicyOverrideSchema.optional(),
});

export type AcquireRequest = z.infer<typeof acquireRequestSchema>;

/**
 * acquire() never blocks on a slow wake-up. Everything up to `stopped` wakes
 * in seconds and returns `ready`; an archived sandbox returns `restoring`
 * with progress immediately, and the caller polls acquire() until it flips
 * to `ready`.
 */
export const acquireResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    sandbox: sandboxSchema,
  }),
  z.object({
    status: z.literal('restoring'),
    sandbox: sandboxSchema,
    progress: z.object({
      /** downloading — pulling the archive from S3; extracting — decompressing onto local disk. */
      phase: z.enum(['downloading', 'extracting']),
      percent: z.number().int().min(0).max(100),
    }),
  }),
]);

export type AcquireResponse = z.infer<typeof acquireResponseSchema>;
