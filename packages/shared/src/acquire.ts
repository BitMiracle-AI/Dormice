import { z } from 'zod';
import { lifecyclePolicyOverrideSchema } from './policy';
import {
  externalIdSchema,
  sandboxMetadataSchema,
  sandboxSchema,
} from './sandbox';
import { templateNameSchema } from './templates';

/**
 * acquire(externalId) — the platform's single entry point. Idempotent:
 * no sandbox → create; frozen → wake; stopped → rebuild; archived → restore.
 */
export const acquireRequestSchema = z.object({
  externalId: externalIdSchema,
  /**
   * Lifecycle override applied when this acquire creates the sandbox;
   * omitted fields fall back to the daemon's global defaults. When the key
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
