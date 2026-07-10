import { describe, expect, it } from 'vitest';
import { FileNotFoundError, NotADirectoryError } from '../executor';
import type { ContractContext } from './index';

/** The directory-entry verbs: stat, list, mkdir, move, remove. */
export function entryTests(ctx: ContractContext) {
  const { timeoutMs } = ctx;

  describe('directory entries', () => {
    it(
      'statEntry reports a file with its real metadata',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          { path: '/home/user/s.txt', content: Buffer.from('12345') },
        ]);
        // Relative path resolves like every other file verb.
        const entry = await ctx.executor.statEntry(id, 's.txt');
        expect(entry).toMatchObject({
          name: 's.txt',
          path: '/home/user/s.txt',
          type: 'file',
          sizeBytes: 5,
          mode: 0o644,
          owner: 'user',
          group: 'user',
        });
        // Written moments ago; both executors report a live clock.
        expect(
          Math.abs(Date.parse(entry.modifiedTime) - Date.now()),
        ).toBeLessThan(60_000);
      },
      timeoutMs,
    );

    it(
      'statEntry reports directories and refuses missing paths',
      async () => {
        const id = await ctx.fresh();
        const home = await ctx.executor.statEntry(id, '/home/user');
        expect(home).toMatchObject({
          name: 'user',
          path: '/home/user',
          type: 'dir',
          mode: 0o755,
          owner: 'user',
        });

        const missing = '/home/user/nope';
        const error = await ctx.executor.statEntry(id, missing).catch((e) => e);
        expect(error).toBeInstanceOf(FileNotFoundError);
        expect(error.message).toBe(`no such file: ${missing}`);
      },
      timeoutMs,
    );

    it(
      'listDir walks exactly as deep as asked, sorted by path',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          { path: '/home/user/a.txt', content: Buffer.from('a') },
          { path: '/home/user/sub/b.txt', content: Buffer.from('b') },
        ]);
        // Depth 1: the file, the created dir — and lost+found, the mkfs
        // artifact every real disk root carries; the listing shows reality.
        const one = await ctx.executor.listDir(id, '/home/user', 1);
        expect(one.map((e) => [e.path, e.type])).toEqual([
          ['/home/user/a.txt', 'file'],
          ['/home/user/lost+found', 'dir'],
          ['/home/user/sub', 'dir'],
        ]);
        const two = await ctx.executor.listDir(id, '/home/user', 2);
        expect(two.map((e) => e.path)).toEqual([
          '/home/user/a.txt',
          '/home/user/lost+found',
          '/home/user/sub',
          '/home/user/sub/b.txt',
        ]);
      },
      timeoutMs,
    );

    it(
      'listDir refuses files and missing paths with the right errors',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          { path: '/home/user/plain.txt', content: Buffer.from('x') },
        ]);
        const onFile = await ctx.executor
          .listDir(id, '/home/user/plain.txt', 1)
          .catch((e) => e);
        expect(onFile).toBeInstanceOf(NotADirectoryError);
        expect(onFile.message).toBe('not a directory: /home/user/plain.txt');

        const onMissing = await ctx.executor
          .listDir(id, '/home/user/void', 1)
          .catch((e) => e);
        expect(onMissing).toBeInstanceOf(FileNotFoundError);
        expect(onMissing.message).toBe('no such file: /home/user/void');
      },
      timeoutMs,
    );

    it(
      'makeDir creates with parents, and reports "already there" as false',
      async () => {
        const id = await ctx.fresh();
        expect(await ctx.executor.makeDir(id, '/home/user/mk/deep')).toBe(true);
        expect(
          await ctx.executor.statEntry(id, '/home/user/mk/deep'),
        ).toMatchObject({ type: 'dir', owner: 'user' });
        // Again: already exists — false, not an error, whatever is there.
        expect(await ctx.executor.makeDir(id, '/home/user/mk/deep')).toBe(
          false,
        );
        await ctx.executor.writeFiles(id, [
          { path: '/home/user/mk/file.txt', content: Buffer.from('f') },
        ]);
        expect(await ctx.executor.makeDir(id, '/home/user/mk/file.txt')).toBe(
          false,
        );
      },
      timeoutMs,
    );

    it(
      'move renames a file and refuses a missing source',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          { path: '/home/user/m1.txt', content: Buffer.from('payload') },
        ]);
        const moved = await ctx.executor.move(
          id,
          '/home/user/m1.txt',
          '/home/user/m2.txt',
        );
        expect(moved).toMatchObject({
          path: '/home/user/m2.txt',
          type: 'file',
          sizeBytes: 7,
        });
        const gone = await ctx.executor
          .readFile(id, '/home/user/m1.txt')
          .catch((e) => e);
        expect(gone).toBeInstanceOf(FileNotFoundError);
        expect(
          (await ctx.executor.readFile(id, '/home/user/m2.txt')).toString(),
        ).toBe('payload');

        const missing = await ctx.executor
          .move(id, '/home/user/void.txt', '/home/user/x.txt')
          .catch((e) => e);
        expect(missing).toBeInstanceOf(FileNotFoundError);
        expect(missing.message).toBe('no such file: /home/user/void.txt');
      },
      timeoutMs,
    );

    it(
      'remove takes a file, takes a tree, refuses what is not there',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          { path: '/home/user/r/a.txt', content: Buffer.from('a') },
          { path: '/home/user/r/sub/b.txt', content: Buffer.from('b') },
          { path: '/home/user/single.txt', content: Buffer.from('s') },
        ]);
        await ctx.executor.remove(id, '/home/user/single.txt');
        await ctx.executor.remove(id, '/home/user/r');
        const statR = await ctx.executor
          .statEntry(id, '/home/user/r')
          .catch((e) => e);
        expect(statR).toBeInstanceOf(FileNotFoundError);

        const again = await ctx.executor
          .remove(id, '/home/user/r')
          .catch((e) => e);
        expect(again).toBeInstanceOf(FileNotFoundError);
        expect(again.message).toBe('no such file: /home/user/r');
      },
      timeoutMs,
    );
  });
}
