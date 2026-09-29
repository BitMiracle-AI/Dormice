import { z } from 'zod';
import { sandboxNameSchema, sandboxSchema } from './sandbox';

/**
 * The cap on everything a sandbox writes outside /home/user — its
 * container layer: /tmp, packages installed with sudo, caches — GiB, the
 * same for every sandbox. /home/user is the sandbox's disk (diskGb) and
 * survives; the container layer is scratch, lost at every stop and every
 * shell swap, and its size is not a sandbox's to choose: under gVisor it
 * is a file on the host's root disk, shared with the images and every
 * other sandbox's layer, and without a cap one sandbox filled that disk
 * for all of them (Beijing, 2026-09-12 and 2026-09-29: a single sandbox's
 * deleted-but-open temp files, 180 GB and 350 GB). Past it, writes fail
 * with ENOSPC inside the sandbox, where `df /` reports it — a limit, not
 * a reservation: the layer grows only as it is written.
 */
export const ROOTFS_LIMIT_GB = 50;

/**
 * Per-sandbox spec sent at acquire time. Same rules as the policy override:
 * applied only when this acquire creates the sandbox — an existing sandbox
 * keeps its stored spec (updateSpec/expandDisk are the update verbs) — but
 * an invalid value is still answered with a 400, never silently ignored.
 * Omitted knobs stay NULL: the sandbox follows the global default.
 */
export const sandboxSpecOverrideSchema = z.object({
  cpus: z.number().positive().optional(),
  memoryGb: z.number().positive().optional(),
  diskGb: z.number().positive().optional(),
});

export type SandboxSpecOverride = z.infer<typeof sandboxSpecOverrideSchema>;

/**
 * updateSpec(name, spec) — the ledger half of a per-sandbox CPU/memory
 * change. A pure ledger write, like updatePolicy: no container is touched,
 * no wake, and the idle clock is NOT refreshed. The physical half happens
 * at the next cold wake, where the shell convergence that already swaps
 * stale images also swaps shells whose CPU/memory limits no longer match
 * the ledger (lifecycle.ts) — a frozen sandbox pays one cold start for it.
 *
 * Patch semantics over the STORED spec: omitted knobs keep their current
 * values, `null` clears a knob back to "follow the global default" (the
 * column's NULL — without it, a once-pinned sandbox could never re-join
 * the fleet-wide knob).
 *
 * Deliberately no diskGb: a disk change is synchronous physical work with
 * a one-way ratchet, its own verb — expandDisk.
 */
export const updateSpecRequestSchema = z.object({
  name: sandboxNameSchema,
  spec: z
    .object({
      cpus: z.number().positive().nullable().optional(),
      memoryGb: z.number().positive().nullable().optional(),
    })
    .refine((s) => s.cpus !== undefined || s.memoryGb !== undefined, {
      message: 'updateSpec needs at least one of cpus, memoryGb',
    }),
});

export type UpdateSpecRequest = z.infer<typeof updateSpecRequestSchema>;

/** The sandbox as it stands after the update (state untouched, spec resolved). */
export const updateSpecResponseSchema = z.object({
  sandbox: sandboxSchema,
});

export type UpdateSpecResponse = z.infer<typeof updateSpecResponseSchema>;

/**
 * expandDisk(name, diskGb) — the one deliberate exception to "the disk
 * never resizes": grow-only, synchronous, done when the response returns.
 * Shrinking is refused with a 400 (a smaller filesystem cannot promise the
 * bytes already on it survive); asking for the size already in force is a
 * no-op success — the goal state holds.
 *
 * Unlike updateSpec this verb does physical work in the call: the image
 * file is grown and the filesystem resized (online when the disk is
 * mounted, offline otherwise). An archived sandbox's disk lives in S3, so
 * only the ledger moves — the restore opens the disk at the recorded size.
 */
export const expandDiskRequestSchema = z.object({
  name: sandboxNameSchema,
  diskGb: z.number().positive(),
});

export type ExpandDiskRequest = z.infer<typeof expandDiskRequestSchema>;

export const expandDiskResponseSchema = z.object({
  sandbox: sandboxSchema,
});

export type ExpandDiskResponse = z.infer<typeof expandDiskResponseSchema>;
