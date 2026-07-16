import { z } from 'zod';

/**
 * listSandboxImages() — every sandbox's image lineage in one answer: which
 * image its current shell was born from, next to the image its next shell
 * would boot. The ledger deliberately records template names, not image
 * strings, so the born image is read from reality (the container object)
 * on demand — this verb is the one window answering "which sandboxes still
 * run an old image?" after a template is re-registered. Observation never
 * wakes a sandbox and never touches its lifecycle.
 *
 * The comparison is by image name, matching "a template is a named image":
 * rebuilding the same tag in place is invisible here — upgrade templates by
 * re-registering a new tag.
 */
export const listSandboxImagesRequestSchema = z.object({});

export type ListSandboxImagesRequest = z.infer<
  typeof listSandboxImagesRequestSchema
>;

export const listSandboxImagesResponseSchema = z.object({
  images: z.array(
    // Prefixed because these reference the sandbox from outside it — and a
    // bare `name` in a row about images would read as an image name.
    z.object({
      sandboxName: z.string(),
      sandboxId: z.string(),
      /**
       * The image the current shell was born from. Null when no shell
       * exists (stopped-and-pruned, archived, restoring): there is nothing
       * to report, and the next start decides — never a guess.
       */
      image: z.string().nullable(),
      /**
       * The image the next shell would boot: the template's current image,
       * or the daemon's base image for template-less sandboxes. Answered
       * for every row, shell or not.
       */
      nextImage: z.string(),
      /**
       * True when the current shell runs an image other than nextImage —
       * rebuildSandbox is the front door to pick the new one up. A row
       * without a shell is false: its next boot upgrades by itself.
       */
      upgradable: z.boolean(),
    }),
  ),
});

export type ListSandboxImagesResponse = z.infer<
  typeof listSandboxImagesResponseSchema
>;
