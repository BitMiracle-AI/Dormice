import { z } from 'zod';
import { userKeySchema } from './sandbox';

/**
 * releaseSandbox(userKey) — the end of a sandbox's life: container and disk
 * are destroyed for good. Idempotent like acquire, and on the same key: the
 * desired end state is "no sandbox under this key", so releasing a key that
 * has nothing is not an error.
 */
export const releaseSandboxRequestSchema = z.object({
  userKey: userKeySchema,
});

export type ReleaseSandboxRequest = z.infer<typeof releaseSandboxRequestSchema>;

export const releaseSandboxResponseSchema = z.object({
  /** True when a sandbox existed and was destroyed; false when the key already had nothing. */
  released: z.boolean(),
});

export type ReleaseSandboxResponse = z.infer<
  typeof releaseSandboxResponseSchema
>;
