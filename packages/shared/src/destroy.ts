import { z } from 'zod';
import { externalIdSchema } from './sandbox';

/**
 * destroySandbox(externalId) — the end of a sandbox's life: container and disk
 * are destroyed for good. Idempotent like acquire, and on the same key: the
 * desired end state is "no sandbox under this key", so destroying a key that
 * has nothing is not an error.
 */
export const destroySandboxRequestSchema = z.object({
  externalId: externalIdSchema,
});

export type DestroySandboxRequest = z.infer<typeof destroySandboxRequestSchema>;

export const destroySandboxResponseSchema = z.object({
  /** True when a sandbox existed and was destroyed; false when the key already had nothing. */
  destroyed: z.boolean(),
});

export type DestroySandboxResponse = z.infer<
  typeof destroySandboxResponseSchema
>;
