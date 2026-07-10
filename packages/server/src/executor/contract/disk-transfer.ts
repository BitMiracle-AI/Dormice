import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContractContext } from './index';

/**
 * exportDisk/importDisk — the archiver's physical halves. The rule under
 * exam: export plus import equals the original disk, and both verbs guard
 * the states they cannot serve. The archive's on-disk format is each
 * executor's own (tar.zst vs JSON); the round-trip is the contract.
 */
export function diskTransferTests(ctx: ContractContext) {
  const { timeoutMs } = ctx;

  describe('disk transfer', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'dormice-contract-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it(
      'a round-trip restores the disk contents',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          { path: 'kept.txt', content: Buffer.from('made it to S3 and back') },
          { path: 'nested/deep.txt', content: Buffer.from('nested too') },
        ]);
        await ctx.executor.freeze(id);
        await ctx.executor.stop(id);
        const archive = path.join(dir, 'disk.archive');
        await ctx.executor.exportDisk(id, archive);
        // The archive is now the only copy — exactly the archiver's world.
        await ctx.executor.destroy(id);
        await ctx.executor.importDisk(id, archive);
        await ctx.executor.start(id);
        expect((await ctx.executor.readFile(id, 'kept.txt')).toString()).toBe(
          'made it to S3 and back',
        );
        expect(
          (await ctx.executor.readFile(id, 'nested/deep.txt')).toString(),
        ).toBe('nested too');
      },
      timeoutMs,
    );

    it(
      'exporting a running sandbox refuses',
      async () => {
        const id = await ctx.fresh();
        await expect(
          ctx.executor.exportDisk(id, path.join(dir, 'x.archive')),
        ).rejects.toThrow(
          `container ${id} is running, expected stopped or absent`,
        );
      },
      timeoutMs,
    );

    it(
      'exporting without a disk refuses',
      async () => {
        const id = randomUUID();
        await expect(
          ctx.executor.exportDisk(id, path.join(dir, 'x.archive')),
        ).rejects.toThrow(`disk ${id} is absent, cannot export`);
      },
      timeoutMs,
    );

    it(
      'importing over an existing disk refuses',
      async () => {
        const id = await ctx.freshStopped();
        const archive = path.join(dir, 'disk.archive');
        await ctx.executor.exportDisk(id, archive);
        await expect(ctx.executor.importDisk(id, archive)).rejects.toThrow(
          `disk ${id} already exists, cannot import`,
        );
      },
      timeoutMs,
    );

    it(
      'import reports monotonic progress ending at 1',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          { path: 'blob.bin', content: Buffer.alloc(256 * 1024, 7) },
        ]);
        await ctx.executor.freeze(id);
        await ctx.executor.stop(id);
        const archive = path.join(dir, 'disk.archive');
        await ctx.executor.exportDisk(id, archive);
        await ctx.executor.destroy(id);
        const fractions: number[] = [];
        await ctx.executor.importDisk(id, archive, (f) => fractions.push(f));
        expect(fractions.length).toBeGreaterThan(0);
        for (let i = 1; i < fractions.length; i++) {
          expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1] ?? 0);
        }
        expect(fractions.at(-1)).toBe(1);
      },
      timeoutMs,
    );

    it(
      'the exported archive is a real, nonempty file',
      async () => {
        // Guards a silent no-op export: the store uploads this very file.
        const id = await ctx.freshStopped();
        const archive = path.join(dir, 'disk.archive');
        await ctx.executor.exportDisk(id, archive);
        expect((await stat(archive)).size).toBeGreaterThan(0);
      },
      timeoutMs,
    );
  });
}
