import { z } from 'zod';
import { lifecyclePolicyOverrideSchema } from './policy';
import {
  sandboxMetadataSchema,
  sandboxNameSchema,
  sandboxSchema,
} from './sandbox';
import { templateNameSchema } from './templates';

/**
 * acquire(name) — the platform's single entry point. Idempotent:
 * no sandbox → create; frozen → wake; stopped → rebuild; archived → restore.
 */
export const acquireRequestSchema = z.object({
  name: sandboxNameSchema,
  /**
   * Lifecycle override applied when this acquire creates the sandbox;
   * omitted fields fall back to the daemon's global defaults. When the name
   * already has a sandbox, the stored policy stays — acquire is not an
   * update verb — but an invalid override is still answered with a 400,
   * never silently ignored.
   */
  policy: lifecyclePolicyOverrideSchema.optional(),
  /**
   * Template to create the sandbox from; omitted means the daemon's base
   * image. Same rules as policy: applied only when this acquire creates the
   * sandbox — an existing sandbox keeps its template — but an unknown
   * template name is still answered with a 400, never silently ignored.
   */
  template: templateNameSchema.optional(),
  /**
   * Labels stored when this acquire creates the sandbox; omitted means no
   * labels. Same rules as policy: an existing sandbox keeps its stored
   * metadata — acquire is not an update verb, updateMetadata is — but a
   * malformed value is still answered with a 400, never silently ignored.
   */
  metadata: sandboxMetadataSchema.optional(),
});

export type AcquireRequest = z.infer<typeof acquireRequestSchema>;

/**
 * acquire() never blocks on a slow wake-up. Everything up to `stopped` wakes
 * in seconds and returns `ready`; an archived sandbox returns `restoring`
 * with progress immediately, and the caller polls acquire() until it flips
 * to `ready`.
 *
 * `created` makes the idempotency observable per call: names collide by
 * converging, never by erroring, so this flag is the only way a caller
 * learns "I got an existing sandbox back" at the moment it happens (and
 * that the policy/template/metadata in the request were therefore ignored).
 */
export const acquireResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    /** True when this acquire created the sandbox; false when the name already had one. */
    created: z.boolean(),
    sandbox: sandboxSchema,
  }),
  z.object({
    status: z.literal('restoring'),
    /** Always false: only an already-archived sandbox restores. */
    created: z.boolean(),
    sandbox: sandboxSchema,
    progress: z.object({
      /** downloading — pulling the archive from S3; extracting — decompressing onto local disk. */
      phase: z.enum(['downloading', 'extracting']),
      percent: z.number().int().min(0).max(100),
    }),
  }),
]);

export type AcquireResponse = z.infer<typeof acquireResponseSchema>;
