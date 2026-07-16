import { z } from 'zod';
import { sandboxNameSchema } from './sandbox';

/**
 * destroySandbox(name) — the end of a sandbox's life: container and disk
 * are destroyed for good. Idempotent like acquire, and on the same name: the
 * desired end state is "no sandbox under this name", so destroying a name
 * that has nothing is not an error.
 */
export const destroySandboxRequestSchema = z.object({
  name: sandboxNameSchema,
});

export type DestroySandboxRequest = z.infer<typeof destroySandboxRequestSchema>;

export const destroySandboxResponseSchema = z.object({
  /** True when a sandbox existed and was destroyed; false when the name already had nothing. */
  destroyed: z.boolean(),
});

export type DestroySandboxResponse = z.infer<
  typeof destroySandboxResponseSchema
>;
