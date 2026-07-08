import {
  DEFAULT_LIFECYCLE_POLICY,
  type LifecyclePolicy,
  type LifecyclePolicyOverride,
  lifecyclePolicySchema,
} from '@dormice/shared';

/**
 * Merges a per-sandbox override over the global defaults and validates the
 * merged result. This is the single arbiter for the freeze <= stop <= archive
 * rule — the override schema itself deliberately carries no ordering check.
 *
 * `archiveAfterSeconds: null` is meaningful (never archive), so only
 * `undefined` falls back to the default.
 */
export function resolvePolicy(
  override?: LifecyclePolicyOverride,
): LifecyclePolicy {
  return lifecyclePolicySchema.parse({
    freezeAfterSeconds:
      override?.freezeAfterSeconds ??
      DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
    stopAfterSeconds:
      override?.stopAfterSeconds ?? DEFAULT_LIFECYCLE_POLICY.stopAfterSeconds,
    archiveAfterSeconds:
      override?.archiveAfterSeconds !== undefined
        ? override.archiveAfterSeconds
        : DEFAULT_LIFECYCLE_POLICY.archiveAfterSeconds,
  });
}
