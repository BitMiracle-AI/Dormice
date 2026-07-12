import { z } from 'zod';
import { lifecyclePolicyOverrideSchema } from './policy';
import { sandboxSchema, userKeySchema } from './sandbox';

/**
 * setPolicy(userKey, policy) — the update verb acquire deliberately is not.
 * Without it, changing a live sandbox's lifecycle (say, promoting it to a
 * never-stop resident agent) would require release + re-acquire, and release
 * destroys the disk — the one thing this platform promises to keep.
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
export const setPolicyRequestSchema = z.object({
  userKey: userKeySchema,
  policy: lifecyclePolicyOverrideSchema,
});

export type SetPolicyRequest = z.infer<typeof setPolicyRequestSchema>;

/** The sandbox as it stands after the update (state untouched). */
export const setPolicyResponseSchema = z.object({
  sandbox: sandboxSchema,
});

export type SetPolicyResponse = z.infer<typeof setPolicyResponseSchema>;
