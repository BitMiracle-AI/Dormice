import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContractContext } from './index';

/**
 * The per-sandbox spec chapter: shells carry the limits they were born
 * with (limitsOf), disks carry a per-disk nominal size (create/importDisk
 * take one, growDisk raises it). Everything here reads through the
 * contract's public window — limitsOf, metrics, and the verbs' own
 * refusals.
 */
export function specTests(ctx: ContractContext) {
  const { timeoutMs } = ctx;

  describe('per-sandbox spec', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'dormice-contract-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it(
      'a shell is born with the limits create names, in integer physical units',
      async () => {
        const id = await ctx.fresh({ cpus: 0.5, memoryGb: 0.5 });
        expect(await ctx.executor.limitsOf(id)).toEqual({
          nanoCpus: 500_000_000,
          memoryBytes: 512 * 1024 ** 2,
        });
      },
      timeoutMs,
    );

    it(
      "limits default to the executor's own configuration when create names none",
      async () => {
        const id = await ctx.fresh();
        const limits = await ctx.executor.limitsOf(id);
        // The exact numbers are each executor's configuration, not the
        // contract's business — but a shell always HAS positive limits.
        expect(limits).not.toBeNull();
        expect(limits?.nanoCpus).toBeGreaterThan(0);
        expect(limits?.memoryBytes).toBeGreaterThan(0);
      },
      timeoutMs,
    );

    it(
      'limitsOf is null when no shell exists — limits are a property of the shell',
      async () => {
        const id = await ctx.fresh({ cpus: 0.5, memoryGb: 0.5 });
        await ctx.executor.freeze(id);
        await ctx.executor.stop(id);
        await ctx.subject.vanishContainer(id);
        expect(await ctx.executor.limitsOf(id)).toBeNull();
        // The rebuild around the surviving disk is born with the NEW limits.
        await ctx.executor.start(id, { cpus: 0.25, memoryGb: 0.25 });
        expect(await ctx.executor.limitsOf(id)).toEqual({
          nanoCpus: 250_000_000,
          memoryBytes: 256 * 1024 ** 2,
        });
      },
      timeoutMs,
    );

    it(
      'a surviving shell keeps its birth limits — start() only starts',
      async () => {
        const id = await ctx.fresh({ cpus: 0.5, memoryGb: 0.5 });
        await ctx.executor.freeze(id);
        await ctx.executor.stop(id);
        // The container object still exists; the options apply only to the
        // rebuild-from-disk path, so the old limits must survive.
        await ctx.executor.start(id, { cpus: 0.25, memoryGb: 0.25 });
        expect(await ctx.executor.limitsOf(id)).toEqual({
          nanoCpus: 500_000_000,
          memoryBytes: 512 * 1024 ** 2,
        });
      },
      timeoutMs,
    );

    it(
      'growDisk grows a live disk in place; at-or-below target is a no-op',
      async () => {
        const id = await ctx.fresh({ diskGb: 1 });
        const before = (await ctx.executor.metrics(id)).diskTotalBytes;
        // Online growth: the sandbox keeps running through the resize.
        await ctx.executor.growDisk(id, 2);
        const after = (await ctx.executor.metrics(id)).diskTotalBytes;
        expect(after).toBeGreaterThan(before * 1.5);
        // Physical grow-only: shrinking back is the goal state already.
        await ctx.executor.growDisk(id, 1);
        expect((await ctx.executor.metrics(id)).diskTotalBytes).toBe(after);
      },
      timeoutMs,
    );

    it(
      'growDisk on an absent disk refuses honestly',
      async () => {
        await expect(ctx.executor.growDisk(randomUUID(), 2)).rejects.toThrow(
          /is absent, cannot grow/,
        );
      },
      timeoutMs,
    );

    it(
      'create sizes the disk from diskGb; importDisk reopens at the size it is told',
      async () => {
        const id = await ctx.fresh({ diskGb: 1 });
        const born = (await ctx.executor.metrics(id)).diskTotalBytes;
        await ctx.executor.writeFiles(id, [
          { path: 'keep.txt', content: Buffer.from('survives the round-trip') },
        ]);
        await ctx.executor.freeze(id);
        await ctx.executor.stop(id);
        const archive = path.join(dir, 'disk.archive');
        await ctx.executor.exportDisk(id, archive);
        await ctx.executor.destroy(id);
        // The restore analog: same archive, larger promise.
        await ctx.executor.importDisk(id, archive, { diskGb: 2 });
        await ctx.executor.start(id);
        expect((await ctx.executor.readFile(id, 'keep.txt')).toString()).toBe(
          'survives the round-trip',
        );
        const reopened = (await ctx.executor.metrics(id)).diskTotalBytes;
        expect(reopened).toBeGreaterThan(born * 1.5);
      },
      timeoutMs,
    );
  });
}
