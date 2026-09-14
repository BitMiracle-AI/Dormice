import { z } from 'zod';
import { silentNodeSchema } from './gateway';
import { sandboxSchema } from './sandbox';

/**
 * listSandboxes() — the observation window into the ledger: every sandbox
 * on this node with its current lifecycle state — or, at the gateway, on
 * every node that answered, concatenated, with the nodes that did not in
 * `silent`. Takes no input; the caller filters. Powers `dor sandbox ls`,
 * the web console, and black-box tests that assert cold states from
 * outside.
 */
export const listSandboxesResponseSchema = z.object({
  sandboxes: z.array(sandboxSchema),
  /** At the gateway: the nodes this answer could not include (gateway.ts silentNodeSchema). A node's own answer carries none. */
  silent: z.array(silentNodeSchema).optional(),
});

export type ListSandboxesResponse = z.infer<typeof listSandboxesResponseSchema>;
