import { z } from 'zod';
import { sandboxSchema } from './sandbox';

/**
 * listSandboxes() — the observation window into the ledger: every sandbox on
 * this daemon with its current lifecycle state. Takes no input; the caller
 * filters. Powers `dor sandbox ls`, the web console, and black-box tests
 * that assert cold states from outside.
 */
export const listSandboxesResponseSchema = z.object({
  sandboxes: z.array(sandboxSchema),
});

export type ListSandboxesResponse = z.infer<typeof listSandboxesResponseSchema>;
