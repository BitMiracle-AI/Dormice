import { z } from 'zod';
import { sandboxNameSchema, sandboxSchema } from './sandbox';

/**
 * rebuildSandbox(name) — swap the container, keep the disk. The disk is
 * the sandbox's body; the container is a replaceable shell built from the
 * daemon's current base image. Removing the shell and letting the next wake
 * rebuild it is how an existing sandbox picks up a new base image without
 * losing a byte of /home/user.
 *
 * Not idempotent-forgiving like destroy: rebuilding a name that has no
 * sandbox is a caller's confusion (a typo, not a goal state) and answers 404.
 */
export const rebuildSandboxRequestSchema = z.object({
  name: sandboxNameSchema,
});

export type RebuildSandboxRequest = z.infer<typeof rebuildSandboxRequestSchema>;

/**
 * The sandbox as it stands after the rebuild: always `stopped` — the old
 * container is gone, the disk waits. The next acquire (or any verb that
 * wakes) builds the new container; rebuild itself does not, so callers pay
 * the cold start only when they actually come back.
 */
export const rebuildSandboxResponseSchema = z.object({
  sandbox: sandboxSchema,
});

export type RebuildSandboxResponse = z.infer<
  typeof rebuildSandboxResponseSchema
>;
