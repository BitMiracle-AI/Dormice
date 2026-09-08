import { z } from 'zod';
import { lifecyclePolicySchema } from './policy';
import { SANDBOX_STATES } from './states';
import { templateNameSchema } from './templates';

/**
 * The caller-chosen name of a sandbox — a user id, a session id, a CI job
 * name — and the identifier every verb addresses sandboxes by. UNIQUE per
 * daemon, but not the way most systems are: acquire(name) never rejects a
 * duplicate — the same name always comes back to the same sandbox, whatever
 * state it was in (get-or-create, like `docker --name` or a Kubernetes
 * metadata.name). The name is the address across lifetimes: destroy a
 * sandbox and acquire its name again, and a brand-new sandbox answers under
 * the old address. Opaque to the daemon; bounded so it can serve as an
 * indexed column.
 */
export const sandboxNameSchema = z.string().min(1).max(128);

/**
 * Caller-owned labels on a sandbox — a string→string map, opaque to the
 * daemon. Grouping is a tagging problem, not an entity problem: no project
 * table, no tenancy, just labels the caller filters on. String values (not
 * arbitrary JSON) because the E2B surface's metadata filter compares them
 * as strings, and one column serves both surfaces.
 */
export const sandboxMetadataSchema = z.record(z.string(), z.string());

export type SandboxMetadata = z.infer<typeof sandboxMetadataSchema>;

/**
 * Per-sandbox resource spec — the per-sandbox layer over the global
 * sandboxDefaults (settings.ts). The ledger stores each knob as NULL =
 * "follow the global default" or a pinned number; the wire always reports
 * the RESOLVED values (NULL already collapsed onto the defaults), because
 * a consumer sizing a plan or a bill needs the number in force, not a
 * two-source riddle.
 *
 * The resolved value is the ledger's ruling, not a physical measurement:
 * CPU/memory are realized at the next shell birth (a cold wake converges a
 * stale shell — lifecycle.ts), disk at the next disk birth (restore) or
 * expandDisk. metrics stays the reader of physical truth.
 */
export const sandboxSpecSchema = z.object({
  /** CPU allowance in force for this sandbox. */
  cpus: z.number().positive(),
  /** Memory cap in force, GiB. */
  memoryGb: z.number().positive(),
  /** Nominal disk size in force, GiB. */
  diskGb: z.number().positive(),
});

export type SandboxSpec = z.infer<typeof sandboxSpecSchema>;

/**
 * How a sandbox's shell last ended when the daemon did not order it — the
 * death the reconciler (or a wake that found the shell dead) recorded:
 *   oom-killed   — the host kernel's memory cgroup killed the container;
 *                  Docker relays the kernel's own verdict
 *   runtime-died — the sandbox runtime itself died: under gVisor exit 2
 *                  with no OOM flag, the signature a pids-cap hit leaves
 *                  (a strong hint, not a kernel verdict)
 *   exited       — any other exit; exitCode is all that is known
 * Stops the daemon ordered (idle policy, rebuild, destroy) are not deaths
 * and never appear here — those are the activity feed's stopped/rebuilt
 * events. The vocabulary mirrors the reconciled event's three wordings.
 */
export const SHELL_EXIT_CAUSES = [
  'oom-killed',
  'runtime-died',
  'exited',
] as const;

export type ShellExitCause = (typeof SHELL_EXIT_CAUSES)[number];

/**
 * The last unordered death of this sandbox's shell, or null if none has
 * happened in this incarnation. Sticky on purpose: it is history, not
 * state — a wake does not clear it (the caller who saw a stream end in EOF
 * reads it right after re-acquiring), only the next death overwrites it and
 * destroy deletes it with the row. `at` is when the container's init
 * exited as the runtime recorded it (Docker's State.FinishedAt) — the
 * death itself, not the moment the daemon noticed: the reconciler notices
 * within one heartbeat, a wake immediately, and the activity feed's
 * `reconciled` event is stamped with the noticing. Millisecond ISO like
 * every other timestamp here.
 */
export const lastExitSchema = z
  .object({
    at: z.iso.datetime(),
    /** The container init's exit code — Docker's State.ExitCode. */
    exitCode: z.number().int(),
    cause: z.enum(SHELL_EXIT_CAUSES),
  })
  .nullable();

export type LastExit = z.infer<typeof lastExitSchema>;

/**
 * A sandbox as reported by the daemon — the wire shape shared by the HTTP
 * API, the SDK, and the web console.
 *
 * Two identities, two jobs: `name` is the caller's address (unique,
 * acquire-idempotent, survives destroy-and-recreate as an address), `id` is
 * the platform's identity for THIS incarnation — rebuild keeps it, destroy
 * plus re-acquire mints a new one. Verbs take `name`; `id` appears only in
 * answers and internal references, never as a request parameter.
 */
export const sandboxSchema = z.object({
  /** Platform-assigned UUID, never a DB autoincrement — ids must stay unique across machines. */
  id: z.string(),
  name: sandboxNameSchema,
  state: z.enum(SANDBOX_STATES),
  /** Machine that owns this sandbox. Single-machine today; the field keeps the ledger shardable. */
  nodeId: z.string(),
  /**
   * Base URL of the daemon that owns this sandbox. Honest limits today: it
   * is the daemon's loopback address, meaningful only on the daemon's own
   * machine — a remote caller keeps using whatever reverse-proxy address it
   * already reached the daemon through. A public-endpoint knob can land
   * when this field gains real consumers (sharding, in-sandbox exec).
   */
  endpoint: z.string(),
  policy: lifecyclePolicySchema,
  /** The resolved per-sandbox resource spec (see sandboxSpecSchema). */
  spec: sandboxSpecSchema,
  /**
   * Template the sandbox was created from; null means the daemon's base
   * image. The name is recorded, not the image it pointed at: a rebuilt
   * shell always boots the template's *current* image.
   */
  template: templateNameSchema.nullable(),
  /** Always an object — `{}` when the sandbox carries no labels. */
  metadata: sandboxMetadataSchema,
  createdAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime(),
  lastExit: lastExitSchema,
});

export type Sandbox = z.infer<typeof sandboxSchema>;
