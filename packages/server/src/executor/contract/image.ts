import { describe, expect, it } from 'vitest';
import type { ContractContext } from './index';

/**
 * Which image a shell boots from — the physical half of templates. The rule
 * under exam: an image is a property of the shell, fixed at the shell's
 * birth (create, or start's rebuild-from-surviving-disk), and never changed
 * by merely starting an existing container.
 */
export function imageTests(ctx: ContractContext) {
  const { timeoutMs } = ctx;

  describe('image', () => {
    it(
      'create boots the requested image',
      async () => {
        const id = await ctx.fresh({ image: ctx.subject.altImage });
        expect(await ctx.subject.imageOf(id)).toBe(ctx.subject.altImage);
      },
      timeoutMs,
    );

    it(
      'create without an image boots the base image',
      async () => {
        const id = await ctx.fresh();
        expect(await ctx.subject.imageOf(id)).toBe(ctx.subject.baseImage);
      },
      timeoutMs,
    );

    it(
      'a rebuilt shell boots the requested image over the same disk',
      async () => {
        // Born on the base image, with data on the disk.
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          { path: 'kept.txt', content: Buffer.from('survives the swap') },
        ]);
        await ctx.executor.freeze(id);
        await ctx.executor.stop(id);
        await ctx.subject.vanishContainer(id);
        // The rebuild is where a new image takes effect: new shell, old disk.
        await ctx.executor.start(id, { image: ctx.subject.altImage });
        expect(await ctx.subject.imageOf(id)).toBe(ctx.subject.altImage);
        const kept = await ctx.executor.readFile(id, 'kept.txt');
        expect(kept.toString()).toBe('survives the swap');
      },
      timeoutMs,
    );

    it(
      'starting an existing container never changes its image',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.freeze(id);
        await ctx.executor.stop(id);
        // The exited container object still exists — start only starts it;
        // the image asked for here must be ignored, not applied.
        await ctx.executor.start(id, { image: ctx.subject.altImage });
        expect(await ctx.subject.imageOf(id)).toBe(ctx.subject.baseImage);
      },
      timeoutMs,
    );
  });
}
