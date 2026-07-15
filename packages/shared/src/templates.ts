import { z } from 'zod';

/**
 * A template is a name for a Docker image that already exists on the daemon's
 * host — nothing more. The host's Docker daemon is the image store; the
 * ledger only records which name points where. The name doubles as the E2B
 * `templateID` (the official SDK sends whatever string the caller passes, so
 * aliases and ids are the same thing on that wire).
 *
 * 'base' is reserved: it always means the daemon's configured base image and
 * can never be registered.
 */
export const templateNameSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/,
    'template name must be 1-64 chars of letters, digits, dots, underscores or dashes, starting alphanumeric',
  )
  .refine((name) => name !== 'base', {
    message: "'base' is reserved — it always means the daemon's base image",
  });

export const templateSchema = z.object({
  name: templateNameSchema,
  /** Docker image reference on the daemon's host, e.g. my-python:3.11. */
  image: z.string().min(1),
  createdAt: z.iso.datetime(),
  /**
   * When the name was last re-pointed at a *different* image — the upgrade
   * timestamp, the ledger half of the "upgradable" verdict on sandboxes.
   * Equals createdAt until the first upgrade; an idempotent re-register of
   * the same image deliberately does not bump it (nothing changed, so the
   * timestamp must not claim otherwise).
   */
  updatedAt: z.iso.datetime(),
});

export type Template = z.infer<typeof templateSchema>;

/**
 * registerTemplate(name, image) — an upsert: registering an existing name
 * re-points it at the new image. That is the template upgrade front door
 * (build a new image, re-register, then rebuildSandbox the stock that should
 * move) — the same declare-desired-state philosophy as acquire.
 *
 * The image is deliberately NOT checked for existence: registration is
 * config, and the image may legitimately arrive later. A sandbox created
 * from a template whose image is missing fails with Docker's own honest
 * "No such image" error.
 */
export const registerTemplateRequestSchema = z.object({
  name: templateNameSchema,
  image: z.string().min(1),
});

export type RegisterTemplateRequest = z.infer<
  typeof registerTemplateRequestSchema
>;

export const registerTemplateResponseSchema = z.object({
  template: templateSchema,
});

export type RegisterTemplateResponse = z.infer<
  typeof registerTemplateResponseSchema
>;

/** listTemplates() — no input, every registered template. */
export const listTemplatesResponseSchema = z.object({
  templates: z.array(templateSchema),
});

export type ListTemplatesResponse = z.infer<typeof listTemplatesResponseSchema>;

/**
 * removeTemplate(name) — refused with a 409 while any sandbox still uses the
 * template (the sandboxes would wake onto a dangling name); idempotent on an
 * unknown name, like destroySandbox: "no template under this name" is the
 * desired end state.
 */
export const removeTemplateRequestSchema = z.object({
  name: templateNameSchema,
});

export type RemoveTemplateRequest = z.infer<typeof removeTemplateRequestSchema>;

export const removeTemplateResponseSchema = z.object({
  /** True when a template existed and was removed; false when the name already had nothing. */
  removed: z.boolean(),
});

export type RemoveTemplateResponse = z.infer<
  typeof removeTemplateResponseSchema
>;
