import { z } from 'zod';
import { sandboxNameSchema, sandboxSchema } from './sandbox';
import { templateNameSchema } from './templates';

/**
 * updateTemplate(name, template) — re-homes an existing sandbox onto
 * another template. Without it, template membership could only ever be
 * set at birth (acquire deliberately ignores the field for existing
 * sandboxes), so a fleet created before a template rename would reference
 * the old name forever — and a later `template rm` of that name would
 * silently drop those sandboxes onto the daemon's base image.
 *
 * `null` detaches: the sandbox follows the daemon's base image, the same
 * meaning as a sandbox created without a template.
 *
 * A pure ledger write, like updateSpec: no container is touched, no wake,
 * and the idle clock is NOT refreshed. The physical shell converges at the
 * next cold wake — wakeSandbox already swaps any shell whose image differs
 * from the template's current image, so this verb needs no machinery of
 * its own. /home/user survives; the running processes of a frozen sandbox
 * pay one cold start, the same honest cost updateSpec documents.
 */
export const updateTemplateRequestSchema = z.object({
  name: sandboxNameSchema,
  template: templateNameSchema.nullable(),
});

export type UpdateTemplateRequest = z.infer<typeof updateTemplateRequestSchema>;

/** The sandbox as it stands after the update (state untouched). */
export const updateTemplateResponseSchema = z.object({
  sandbox: sandboxSchema,
});

export type UpdateTemplateResponse = z.infer<
  typeof updateTemplateResponseSchema
>;
