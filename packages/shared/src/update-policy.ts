import { z } from 'zod';
import { lifecyclePolicyOverrideSchema } from './policy';
import { sandboxNameSchema, sandboxSchema } from './sandbox';

/**
 * updatePolicy(name, policy) — the update verb acquire deliberately is not.
 * Without it, changing a live sandbox's lifecycle (say, promoting it to a
 * never-stop resident agent) would require destroy + re-acquire, and destroy
 * removes the disk — the one thing this platform promises to keep.
 *
 * Patch semantics over the STORED policy: omitted fields keep their current
 * values, `null` still means "never take that step". The merged result is
 * validated by `lifecyclePolicySchema` — the same single arbiter as acquire —
 * so an update can never leave a policy acquire would have refused.
 *
 * A pure ledger write: no container is touched, no wake, and the idle clock
 * is NOT refreshed — adjusting a knob is not sandbox activity, and the new
 * thresholds apply to the idle time already accumulated.
 */
export const updatePolicyRequestSchema = z.object({
  name: sandboxNameSchema,
  policy: lifecyclePolicyOverrideSchema,
});

export type UpdatePolicyRequest = z.infer<typeof updatePolicyRequestSchema>;

/** The sandbox as it stands after the update (state untouched). */
export const updatePolicyResponseSchema = z.object({
  sandbox: sandboxSchema,
});

export type UpdatePolicyResponse = z.infer<typeof updatePolicyResponseSchema>;
