import {
  DEFAULT_LIFECYCLE_POLICY,
  type LifecyclePolicy,
  type LifecyclePolicyOverride,
  lifecyclePolicySchema,
} from '@dormice/shared';

/**
 * The default distance from stopped to archived, applied only when the
 * daemon actually has an archiver (S3 configured) — the shared default
 * stays null because a promise nobody can honor is a standing lie.
 */
export const ARCHIVE_DEFAULT_SECONDS = 7 * 24 * 60 * 60;

/** An archive-asking policy on a daemon that has no archiver. */
export class ArchiveDisabledError extends Error {
  constructor() {
    super('archiving requires S3 (DORMICE_S3_*) to be configured');
  }
}

/**
 * Merges a per-sandbox override over the defaults and validates the merged
 * result. This is the single arbiter for the freeze <= stop <= archive rule
 * — the override schema itself deliberately carries no ordering check.
 *
 * `null` is meaningful for stop and archive ("never take that step"), so
 * only `undefined` falls back to the default.
 *
 * archiveDefaultSeconds is the caller's adjudication of "is the archiver
 * configured" (null = no): every call site answers explicitly. With no
 * archiver, an override explicitly asking to archive is refused — and the
 * archive default is null. With one, the default yields to an explicit
 * stop rather than fighting it: a never-stop sandbox never archives (only
 * a stopped sandbox can), and a stop pushed past the archive default drags
 * the default along instead of turning a legal stop override into an
 * ordering error.
 */
export function resolvePolicy(
  override: LifecyclePolicyOverride | undefined,
  archiveDefaultSeconds: number | null,
): LifecyclePolicy {
  if (archiveDefaultSeconds === null && override?.archiveAfterSeconds != null) {
    throw new ArchiveDisabledError();
  }
  const stopAfterSeconds =
    override?.stopAfterSeconds !== undefined
      ? override.stopAfterSeconds
      : DEFAULT_LIFECYCLE_POLICY.stopAfterSeconds;
  const archiveDefault =
    archiveDefaultSeconds === null || stopAfterSeconds === null
      ? null
      : Math.max(archiveDefaultSeconds, stopAfterSeconds);
  return lifecyclePolicySchema.parse({
    freezeAfterSeconds:
      override?.freezeAfterSeconds ??
      DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
    stopAfterSeconds,
    archiveAfterSeconds:
      override?.archiveAfterSeconds !== undefined
        ? override.archiveAfterSeconds
        : archiveDefault,
  });
}
