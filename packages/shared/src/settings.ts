import { z } from 'zod';
import { lifecyclePolicySchema } from './policy';

/**
 * Runtime settings — the operator knobs that live in the ledger, not the
 * environment. The dividing line (2026-07-19): a knob belongs here exactly
 * when changing it is an operations decision that must not require shell
 * access and a restart (capacity, what new sandboxes get); it stays an env
 * variable when changing it makes a different daemon (port, token,
 * executor, data dir).
 *
 * The sandbox domain and the S3 archive store used to sit on the env side
 * of that line; overturned 2026-07-26: the archive backend and the port-
 * preview domain are operations switches, not daemon identity — turning
 * archiving on, or pointing previews at a domain, must not require shell
 * access and a restart. The daemon still never rewrites its own env; the
 * env variables became first-boot seeds like the rest.
 *
 * The env variables of the same names still exist — as first-boot seeds
 * only. Once a knob's ledger column holds a value, the ledger is the
 * single truth and a later env edit is deliberately ignored: two live
 * sources for one knob is a standing ambiguity, and the ledger is the
 * daemon's one writable truth.
 */
export const sandboxResourceDefaultsSchema = z.object({
  /**
   * CPU allowance per sandbox. The fleet-wide layer under the per-sandbox
   * spec (spec.ts): a sandbox with no pinned value follows this knob.
   * Applies to every container launched after the change — and, since the
   * cold-wake convergence compares limits (2026-07-31), to every unpinned
   * sandbox at its next cold wake.
   */
  cpus: z.number().positive(),
  /** Memory cap per sandbox, GiB. Same application as cpus. */
  memoryGb: z.number().positive(),
  /**
   * Nominal disk size per sandbox, GiB. Consulted only when a disk is born
   * (first create, restore-from-archive) — an existing sandbox's disk never
   * resizes, with exactly one sanctioned exception: expandDisk, grow-only.
   */
  diskGb: z.number().positive(),
});

export type SandboxResourceDefaults = z.infer<
  typeof sandboxResourceDefaultsSchema
>;

/**
 * A bare hostname: no scheme, no port, no leading or trailing dot. The one
 * regex both the env seed (server config.ts) and the wire (updateSettings'
 * sandboxDomain) validate against — two dialects of "hostname" would let a
 * value seed at boot that the console then refuses to write back.
 */
export const bareHostnameRegex =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * The S3 archive store, write shape — what updateSettings takes. All six
 * fields every time, secret included: a provided group replaces that group
 * whole (the updatePolicy doctrine), and a "blank keeps the old secret"
 * special case would be exactly the field-level merge ambiguity that
 * doctrine exists to kill. Re-typing a key on edit is a cost paid rarely,
 * by an operator, on purpose.
 */
export const s3ArchiveSettingsSchema = z.object({
  /** Full http(s) URL of the S3-compatible endpoint (MinIO speaks http, the clouds https). */
  endpoint: z.url({ protocol: /^https?$/ }),
  bucket: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  region: z.string().min(1),
  /** Path-style addressing: MinIO needs true; the clouds route by subdomain. */
  forcePathStyle: z.boolean(),
});

export type S3ArchiveSettings = z.infer<typeof s3ArchiveSettingsSchema>;

/**
 * The S3 archive store, read shape — what getConfig and updateSettings
 * responses carry. Both keys are withheld, not just the secret: the env
 * observability window already adjudicated DORMICE_S3_ACCESS_KEY_ID as
 * sensitive, and the wire keeps one story — secrets are present-or-absent,
 * their value never crosses, whoever asks.
 */
export const s3ArchiveViewSchema = z.object({
  endpoint: z.string(),
  bucket: z.string(),
  region: z.string(),
  forcePathStyle: z.boolean(),
});

export type S3ArchiveView = z.infer<typeof s3ArchiveViewSchema>;

export const runtimeSettingsSchema = z.object({
  /** How many sandboxes may exist at once; past it, creation answers 429. Wakes are never blocked. */
  maxSandboxes: z.number().int().positive(),
  sandboxDefaults: sandboxResourceDefaultsSchema,
  /** What acquire() gives a sandbox that asks for nothing. Existing sandboxes keep theirs. */
  defaultPolicy: lifecyclePolicySchema,
  /**
   * Total daemon-managed swap, GiB, held as swapfiles on the data dir —
   * ON TOP of whatever swap the host already has (the install-time
   * swapfile stays fstab's business; the two never fight). Swap capacity
   * is roughly "how much sandbox memory can hibernate at once" — freezing
   * squeezes a sandbox's memory into swap. Growing takes effect
   * immediately; shrinking is deferred to the next host reboot, because
   * swapoff would drag every frozen sandbox's memory back into RAM
   * (getConfig's `swap.activeGb` reports what is actually mounted).
   * 0 = manage none. Ignored on hosts that cannot swap (see getConfig's
   * `swap.supported`), where updateSettings refuses to set it.
   */
  swapGb: z.number().int().nonnegative(),
  /**
   * The S3 archive store in force; null = archiving is off and sandboxes
   * park at stopped forever. The read shape — keys withheld (see
   * s3ArchiveViewSchema). Changing endpoint or bucket, or clearing, is
   * refused while any sandbox is archived or restoring: those disks live
   * in the current store, and moving the pointer would strand them.
   */
  s3: s3ArchiveViewSchema.nullable(),
  /**
   * The sandbox wildcard domain behind getHost() and port previews
   * (`<port>-<sandboxId>.<domain>`); null = the feature is off and
   * responses carry no domain. Applies live: the proxy, the E2B domain
   * field and the signed-URL host pin all read this per use.
   */
  sandboxDomain: z.string().regex(bareHostnameRegex).nullable(),
  /** ISO 8601 of the last updateSettings; null = still exactly the first-boot seed. */
  updatedAt: z.string().nullable(),
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

/**
 * updateSettings(patch) — every provided group replaces that group whole
 * (the updatePolicy doctrine: what the form shows is what gets written, no
 * field-level merge ambiguity); absent groups stay untouched. At least one
 * group must be present — an empty patch is a caller confusion, not a no-op.
 */
export const updateSettingsRequestSchema = z
  .object({
    maxSandboxes: z.number().int().positive().optional(),
    sandboxDefaults: sandboxResourceDefaultsSchema.optional(),
    defaultPolicy: lifecyclePolicySchema.optional(),
    swapGb: z.number().int().nonnegative().optional(),
    /** Write shape (all six fields, secret included); null clears the store and turns archiving off. */
    s3: s3ArchiveSettingsSchema.nullable().optional(),
    /** A bare hostname; null turns the sandbox proxy and domain fields off. */
    sandboxDomain: z
      .string()
      .regex(bareHostnameRegex, {
        error:
          'sandboxDomain must be a bare hostname like sbx.example.com — no scheme, no port, no leading/trailing dots',
      })
      .nullable()
      .optional(),
  })
  .refine(
    (patch) =>
      patch.maxSandboxes !== undefined ||
      patch.sandboxDefaults !== undefined ||
      patch.defaultPolicy !== undefined ||
      patch.swapGb !== undefined ||
      patch.s3 !== undefined ||
      patch.sandboxDomain !== undefined,
    {
      message:
        'updateSettings needs at least one of maxSandboxes, sandboxDefaults, defaultPolicy, swapGb, s3, sandboxDomain',
    },
  );

export type UpdateSettingsRequest = z.input<typeof updateSettingsRequestSchema>;

export const updateSettingsResponseSchema = z.object({
  settings: runtimeSettingsSchema,
});

export type UpdateSettingsResponse = z.infer<
  typeof updateSettingsResponseSchema
>;
