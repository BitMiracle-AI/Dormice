import { z } from 'zod';
import { lifecyclePolicySchema } from './policy';

/**
 * Runtime settings — the fleet-wide operator knobs, the ones that live in
 * a table, not the environment. The dividing line (2026-07-19): a knob
 * belongs here exactly when changing it is an operations decision that
 * must not require shell access and a restart (what new sandboxes get);
 * it stays an env variable when changing it makes a different process
 * (port, token, executor, data dir). Since the configuration authority
 * moved to the gateway (2026-09-14) the table is the gateway's and every
 * node keeps a copy; a knob that is one machine's rather than the fleet's
 * — the managed swap target — is a node's row instead (gateway.ts
 * updateNodeSettings).
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

/**
 * The lowest pids cap updateSettings accepts (2026-09-08, operator's call).
 * Below a few hundred the sandbox's own runtime cannot even boot its
 * threads, so a lower value is not a stricter sandbox — it is a dead one.
 */
export const PIDS_LIMIT_MIN = 256;

export const runtimeSettingsSchema = z.object({
  sandboxDefaults: sandboxResourceDefaultsSchema,
  /** What acquire() gives a sandbox that asks for nothing. Existing sandboxes keep theirs. */
  defaultPolicy: lifecyclePolicySchema,
  /**
   * The S3 archive store in force; null = archiving is off and sandboxes
   * park at stopped forever. The read shape — keys withheld (see
   * s3ArchiveViewSchema). Changing endpoint or bucket, or clearing, is
   * refused while any sandbox is archived or restoring: those disks live
   * in the current store, and moving the pointer would strand them.
   */
  s3: s3ArchiveViewSchema.nullable(),
  /**
   * The canonical sandbox wildcard domain behind getHost() and port
   * previews (`<port>-<sandboxId>.<domain>`); null = the feature is off
   * and responses carry no domain. Applies live: the proxy, the E2B domain
   * field and the signed-URL host pin all read this per use.
   */
  sandboxDomain: z.string().regex(bareHostnameRegex).nullable(),
  /**
   * Extra sandbox wildcard domains, inbound-only: the port proxy and the
   * signed-URL host pin accept them, while everything outbound (the E2B
   * domain field, preview URLs) always speaks the canonical sandboxDomain.
   * That asymmetry is the domain-migration story — add the new domain as
   * an alias, wait for DNS, then swap it into sandboxDomain in one patch;
   * URLs minted under the old domain keep resolving for as long as it
   * stays listed. Never null: [] = no aliases, and the route refuses a
   * state with aliases but no canonical domain.
   */
  sandboxDomainAliases: z.array(z.string().regex(bareHostnameRegex)),
  /**
   * The pids cgroup cap on every sandbox container. Under gVisor this is
   * the sandbox's host-side thread-and-process budget (sentry threads,
   * gofer, one stub per guest process), not a count the sandbox can see:
   * hitting it kills the whole sandbox at once (exit 2, no OOM). Applies
   * live — new containers are born with it and existing shells adopt it
   * at their next wake, no rebuild. Floored at PIDS_LIMIT_MIN and never
   * unlimited: the cap is what keeps a fork bomb inside its own sandbox.
   */
  pidsLimit: z.number().int().min(PIDS_LIMIT_MIN),
  /**
   * The image a sandbox without a template boots from — the fleet's base
   * image (images/Dockerfile), a bare reference like
   * `dormice-base:20260831`. A fleet setting since the fourth cut
   * (2026-09-15): one base for every node, pulled from the fleet's
   * registry by a node that lacks it (gateway.ts nodeConfigBundleSchema
   * carries it in the bundle). Changing it is the base's re-point, the
   * template's `registerTemplate` for template-less sandboxes: each one
   * converges onto it at its next cold wake. Null = none set — a node then
   * falls back to its own DORMICE_BASE_IMAGE, the knob's old home, and
   * says so, or refuses to build a template-less sandbox.
   */
  baseImage: z.string().nullable(),
  /**
   * The fleet's image registry, host and port (`10.0.0.5:5000`), where a
   * node that lacks an image pulls it from — `<registryAddress>/<image>`,
   * tagged back under the bare name so nothing else changes. Null = no
   * registry (a laptop, the exam): a missing image is then an honest error
   * naming the host. Seeded from the gateway's DORMICE_REGISTRY_ADDRESS
   * and read-only over the wire in this cut — moving a fleet to another
   * registry is an operator's action, not a console knob yet.
   */
  registryAddress: z.string().nullable(),
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
    sandboxDefaults: sandboxResourceDefaultsSchema.optional(),
    defaultPolicy: lifecyclePolicySchema.optional(),
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
    /** The full alias list (set semantics, like setIngress); [] clears. Not nullable — "off" belongs to sandboxDomain. */
    sandboxDomainAliases: z
      .array(
        z.string().regex(bareHostnameRegex, {
          error:
            'each sandboxDomainAliases entry must be a bare hostname like sbx2.example.com — no scheme, no port, no leading/trailing dots',
        }),
      )
      .optional(),
    /** The pids cgroup cap for every sandbox; floored, never unlimited. */
    pidsLimit: z
      .number()
      .int()
      .min(PIDS_LIMIT_MIN, {
        error: `pidsLimit must be at least ${PIDS_LIMIT_MIN} — below that a sandbox cannot boot its own runtime`,
      })
      .optional(),
    /** The fleet's base image, a bare image reference; never null — a fleet cannot un-know its base, only re-point it. */
    baseImage: z
      .string()
      .regex(/^\S+$/, {
        error:
          'baseImage must be an image reference like dormice-base:20260831 — no spaces',
      })
      .optional(),
  })
  .refine(
    (patch) =>
      patch.pidsLimit !== undefined ||
      patch.sandboxDefaults !== undefined ||
      patch.defaultPolicy !== undefined ||
      patch.s3 !== undefined ||
      patch.sandboxDomain !== undefined ||
      patch.sandboxDomainAliases !== undefined ||
      patch.baseImage !== undefined,
    {
      message:
        'updateSettings needs at least one of sandboxDefaults, defaultPolicy, s3, sandboxDomain, sandboxDomainAliases, pidsLimit, baseImage',
    },
  );

export type UpdateSettingsRequest = z.input<typeof updateSettingsRequestSchema>;

export const updateSettingsResponseSchema = z.object({
  settings: runtimeSettingsSchema,
});

export type UpdateSettingsResponse = z.infer<
  typeof updateSettingsResponseSchema
>;
