import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { FILE_SIZE_LIMIT_BYTES } from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import {
  FileNotFoundError,
  FileTooLargeError,
  NotAFileError,
} from '../executor';
import type { ContractContext } from './index';

/** File content in and out: the buffered pair and the uncapped streams. */
export function fileTests(ctx: ContractContext) {
  const { timeoutMs } = ctx;

  describe('files', () => {
    it(
      'writeFiles then readFile round-trips text',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          { path: '/home/user/hello.txt', content: Buffer.from('hello\n') },
        ]);
        const read = await ctx.executor.readFile(id, '/home/user/hello.txt');
        expect(read.toString('utf8')).toBe('hello\n');
      },
      timeoutMs,
    );

    it(
      'file content round-trips byte-exact, binary included',
      async () => {
        const id = await ctx.fresh();
        // Every byte value, repeated — any encoding sloppiness (utf8 coercion,
        // base64 mangling, CR/LF translation) breaks the exact comparison.
        const bytes = Buffer.alloc(256 * 64);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
        await ctx.executor.writeFiles(id, [
          { path: '/home/user/blob.bin', content: bytes },
        ]);
        const read = await ctx.executor.readFile(id, '/home/user/blob.bin');
        expect(read.equals(bytes)).toBe(true);
      },
      timeoutMs,
    );

    it(
      'writeFiles writes the whole batch',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          { path: '/home/user/a.txt', content: Buffer.from('a') },
          { path: '/home/user/b.txt', content: Buffer.from('b') },
          { path: '/home/user/c.txt', content: Buffer.from('c') },
        ]);
        expect(
          (await ctx.executor.readFile(id, '/home/user/a.txt')).toString(),
        ).toBe('a');
        expect(
          (await ctx.executor.readFile(id, '/home/user/b.txt')).toString(),
        ).toBe('b');
        expect(
          (await ctx.executor.readFile(id, '/home/user/c.txt')).toString(),
        ).toBe('c');
      },
      timeoutMs,
    );

    it(
      'relative paths resolve against /home/user',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          { path: 'rel.txt', content: Buffer.from('via relative') },
        ]);
        const read = await ctx.executor.readFile(id, '/home/user/rel.txt');
        expect(read.toString('utf8')).toBe('via relative');
      },
      timeoutMs,
    );

    it(
      'writeFiles creates missing parent directories',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          {
            path: '/home/user/deep/er/nested.txt',
            content: Buffer.from('deep'),
          },
        ]);
        const read = await ctx.executor.readFile(
          id,
          '/home/user/deep/er/nested.txt',
        );
        expect(read.toString('utf8')).toBe('deep');
      },
      timeoutMs,
    );

    it(
      'writing an existing path overwrites it',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          { path: '/home/user/v.txt', content: Buffer.from('first') },
        ]);
        await ctx.executor.writeFiles(id, [
          { path: '/home/user/v.txt', content: Buffer.from('second') },
        ]);
        const read = await ctx.executor.readFile(id, '/home/user/v.txt');
        expect(read.toString('utf8')).toBe('second');
      },
      timeoutMs,
    );

    it(
      'files live on the disk: they survive stop, start, even a vanished container',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          { path: '/home/user/keep.txt', content: Buffer.from('still here') },
        ]);
        await ctx.executor.freeze(id);
        await ctx.executor.stop(id);
        // The container object itself is lost (a prune) — the disk, which
        // holds the files, is the sandbox's actual body.
        await ctx.subject.vanishContainer(id);
        await ctx.executor.start(id);
        const read = await ctx.executor.readFile(id, '/home/user/keep.txt');
        expect(read.toString('utf8')).toBe('still here');
      },
      timeoutMs,
    );

    it(
      'readFile on a missing path throws FileNotFoundError',
      async () => {
        const id = await ctx.fresh();
        const missing = '/home/user/absent.txt';
        const error = await ctx.executor.readFile(id, missing).catch((e) => e);
        expect(error).toBeInstanceOf(FileNotFoundError);
        expect(error.message).toBe(`no such file: ${missing}`);
      },
      timeoutMs,
    );

    it(
      'readFile on a directory throws NotAFileError',
      async () => {
        const id = await ctx.fresh();
        // /home/user exists as a directory in every sandbox by construction.
        const error = await ctx.executor
          .readFile(id, '/home/user')
          .catch((e) => e);
        expect(error).toBeInstanceOf(NotAFileError);
        expect(error.message).toBe('not a regular file: /home/user');
      },
      timeoutMs,
    );

    it(
      'writeFiles onto a directory throws NotAFileError',
      async () => {
        const id = await ctx.fresh();
        const error = await ctx.executor
          .writeFiles(id, [{ path: '/home/user', content: Buffer.from('x') }])
          .catch((e) => e);
        expect(error).toBeInstanceOf(NotAFileError);
        expect(error.message).toBe('not a regular file: /home/user');
      },
      timeoutMs,
    );

    it(
      'readFile refuses an over-limit file with its actual size, never truncates',
      async () => {
        const id = await ctx.fresh();
        // One byte over the line. The executor's write path is deliberately
        // uncapped (the protocol schema is the write-cap adjudicator), which
        // is exactly what lets the exam stage an over-limit file to read.
        const size = FILE_SIZE_LIMIT_BYTES + 1;
        await ctx.executor.writeFiles(id, [
          { path: '/home/user/big.bin', content: Buffer.alloc(size) },
        ]);
        const error = await ctx.executor
          .readFile(id, '/home/user/big.bin')
          .catch((e) => e);
        expect(error).toBeInstanceOf(FileTooLargeError);
        expect(error.message).toBe(
          `file too large: /home/user/big.bin is ${size} bytes, limit ${FILE_SIZE_LIMIT_BYTES}`,
        );
      },
      timeoutMs * 4,
    );

    it(
      'rejects file operations on a container that is not running',
      async () => {
        const paused = await ctx.fresh();
        await ctx.executor.freeze(paused);
        await expect(
          ctx.executor.writeFiles(paused, [
            { path: 'x.txt', content: Buffer.from('x') },
          ]),
        ).rejects.toThrow(/is paused, expected running/);
        await expect(ctx.executor.readFile(paused, 'x.txt')).rejects.toThrow(
          /is paused, expected running/,
        );

        await expect(
          ctx.executor.readFile(randomUUID(), 'x.txt'),
        ).rejects.toThrow(/is absent, expected running/);
      },
      timeoutMs,
    );

    it(
      'the streaming file path is the uncapped one: over-limit content round-trips byte-exact',
      async () => {
        const id = await ctx.fresh();
        // Past the buffered API's 16 MiB line — only the stream may carry it.
        const size = FILE_SIZE_LIMIT_BYTES + 5;
        const big = Buffer.alloc(size);
        for (let i = 0; i < size; i += 4096) big[i] = i % 251;
        const half = Math.floor(size / 2);
        await ctx.executor.writeFileStream(
          id,
          '/home/user/big-stream.bin',
          Readable.from([big.subarray(0, half), big.subarray(half)]),
        );
        const chunks: Buffer[] = [];
        await ctx.executor.readFileStream(
          id,
          '/home/user/big-stream.bin',
          (c) => {
            chunks.push(Buffer.from(c));
          },
        );
        expect(Buffer.concat(chunks).equals(big)).toBe(true);
        // The buffered read still refuses it: two paths, two contracts.
        await expect(
          ctx.executor.readFile(id, '/home/user/big-stream.bin'),
        ).rejects.toThrow(FileTooLargeError);
      },
      timeoutMs * 4,
    );

    it(
      'a byte range slices the stream exactly — offset and length, byte math',
      async () => {
        // The HTTP Range request's muscle: a video player's tail-of-file
        // moov probe and a seek are both "give me exactly these bytes".
        const id = await ctx.fresh();
        const content = Buffer.from('0123456789abcdefghij');
        await ctx.executor.writeFiles(id, [
          { path: '/home/user/range.bin', content },
        ]);
        const read = async (offset: number, length: number) => {
          const chunks: Buffer[] = [];
          await ctx.executor.readFileStream(
            id,
            '/home/user/range.bin',
            (c) => {
              chunks.push(Buffer.from(c));
            },
            undefined,
            { offset, length },
          );
          return Buffer.concat(chunks).toString('utf8');
        };
        expect(await read(0, 5)).toBe('01234'); // head
        expect(await read(10, 10)).toBe('abcdefghij'); // tail, to EOF exactly
        expect(await read(19, 1)).toBe('j'); // the last byte alone
        expect(await read(7, 6)).toBe('789abc'); // an interior seek
      },
      timeoutMs,
    );

    it(
      'streaming file verbs throw the same typed errors as the buffered ones',
      async () => {
        const id = await ctx.fresh();
        const missing = await ctx.executor
          .readFileStream(id, '/home/user/void.bin', () => {})
          .catch((e) => e);
        expect(missing).toBeInstanceOf(FileNotFoundError);
        expect(missing.message).toBe('no such file: /home/user/void.bin');

        const onDir = await ctx.executor
          .readFileStream(id, '/home/user', () => {})
          .catch((e) => e);
        expect(onDir).toBeInstanceOf(NotAFileError);
        expect(onDir.message).toBe('not a regular file: /home/user');

        const writeDir = await ctx.executor
          .writeFileStream(id, '/home/user', Readable.from([Buffer.from('x')]))
          .catch((e) => e);
        expect(writeDir).toBeInstanceOf(NotAFileError);
        expect(writeDir.message).toBe('not a regular file: /home/user');
      },
      timeoutMs,
    );
  });
}
