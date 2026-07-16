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
});

export type Sandbox = z.infer<typeof sandboxSchema>;
