import {
  type LifecyclePolicy,
  type LifecyclePolicyOverride,
  lifecyclePolicySchema,
} from '@dormice/shared';

/**
 * The default distance from stopped to archived, applied only when the
 * daemon actually has an archiver (S3 configured) — the shared default
 * stays null because a promise nobody can honor is a standing lie. Since
 * runtime settings landed this is only the first-boot SEED of the ledger's
 * defaultPolicy.archiveAfterSeconds; the ledger value is what acquires read.
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
 * `defaults` is the ledger's defaultPolicy (runtime settings — what a
 * sandbox that asks for nothing gets). `archiveEnabled` is the caller's
 * adjudication of "is the archiver configured", decided once per boot by
 * the archiver's presence; it is a separate flag because a null default
 * archive is ambiguous on its own — it means either "no archiver" or "an
 * operator chose never-archive by default", and only the first refuses an
 * explicit archive-asking override. The archive default yields to an
 * explicit stop rather than fighting it: a never-stop sandbox never
 * archives (only a stopped sandbox can), and a stop pushed past the archive
 * default drags the default along instead of turning a legal stop override
 * into an ordering error.
 */
export function resolvePolicy(
  override: LifecyclePolicyOverride | undefined,
  defaults: LifecyclePolicy,
  archiveEnabled: boolean,
): LifecyclePolicy {
  if (!archiveEnabled && override?.archiveAfterSeconds != null) {
    throw new ArchiveDisabledError();
  }
  const stopAfterSeconds =
    override?.stopAfterSeconds !== undefined
      ? override.stopAfterSeconds
      : defaults.stopAfterSeconds;
  const archiveDefault =
    defaults.archiveAfterSeconds === null || stopAfterSeconds === null
      ? null
      : Math.max(defaults.archiveAfterSeconds, stopAfterSeconds);
  return lifecyclePolicySchema.parse({
    freezeAfterSeconds:
      override?.freezeAfterSeconds ?? defaults.freezeAfterSeconds,
    stopAfterSeconds,
    archiveAfterSeconds:
      override?.archiveAfterSeconds !== undefined
        ? override.archiveAfterSeconds
        : archiveDefault,
  });
}
