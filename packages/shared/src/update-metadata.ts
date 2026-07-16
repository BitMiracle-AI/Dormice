import { z } from 'zod';
import {
  sandboxMetadataSchema,
  sandboxNameSchema,
  sandboxSchema,
} from './sandbox';

/**
 * updateMetadata(name, metadata) — the update verb acquire deliberately
 * is not. Without it, a sandbox could only ever be labeled at birth: the
 * fleet you already run would be un-groupable forever.
 *
 * Full replacement, not a patch: metadata is one label set, and "what you
 * send is what is stored" reads unambiguously — `{}` clears every label.
 * Per-key patching would need a tombstone convention (null? absent?) for
 * deletes, complexity a tag map doesn't earn.
 *
 * A pure ledger write, like updatePolicy: no container is touched, no wake,
 * and the idle clock is NOT refreshed — relabeling is not sandbox activity.
 */
export const updateMetadataRequestSchema = z.object({
  name: sandboxNameSchema,
  metadata: sandboxMetadataSchema,
});

export type UpdateMetadataRequest = z.infer<typeof updateMetadataRequestSchema>;

/** The sandbox as it stands after the update (state untouched). */
export const updateMetadataResponseSchema = z.object({
  sandbox: sandboxSchema,
});

export type UpdateMetadataResponse = z.infer<
  typeof updateMetadataResponseSchema
>;
