import { describe, expect, it } from 'vitest';
import { FileNotFoundError, NotADirectoryError } from '../executor';
import type { ContractContext } from './index';

/**
 * watchDir. Assertions are inclusion, never counts: one real write can
 * surface as several MODIFY lines, and event multiplicity is the kernel's
 * business, not the contract's.
 */
export function watchTests(ctx: ContractContext) {
  const { timeoutMs } = ctx;

  /** Collects events; watch() must be awaited before the change is made. */
  function eventLog() {
    const events: Array<{ name: string; type: string }> = [];
    return {
      events,
      onEvent: (e: { name: string; type: string }) => {
        events.push({ ...e });
      },
      has: (name: string, type: string) =>
        events.some((e) => e.name === name && e.type === type),
    };
  }

  describe('watchDir', () => {
    it(
      'a watcher sees a new file as create and write, an overwrite as write',
      async () => {
        const id = await ctx.fresh();
        const log = eventLog();
        const watch = await ctx.executor.watchDir(id, {
          path: '/home/user',
          recursive: false,
          onEvent: log.onEvent,
          onEnd: () => {},
        });
        await ctx.executor.writeFiles(id, [
          { path: 'seen.txt', content: Buffer.from('one') },
        ]);
        await ctx.until(() => log.has('seen.txt', 'create'));
        await ctx.until(() => log.has('seen.txt', 'write'));

        log.events.length = 0;
        await ctx.executor.writeFiles(id, [
          { path: 'seen.txt', content: Buffer.from('two') },
        ]);
        await ctx.until(() => log.has('seen.txt', 'write'));
        expect(log.has('seen.txt', 'create')).toBe(false);
        await watch.stop();
      },
      timeoutMs,
    );

    it(
      'a watcher sees removals, and a move as rename plus create',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          { path: 'old.txt', content: Buffer.from('x') },
          { path: 'doomed.txt', content: Buffer.from('y') },
        ]);
        const log = eventLog();
        const watch = await ctx.executor.watchDir(id, {
          path: '/home/user',
          recursive: false,
          onEvent: log.onEvent,
          onEnd: () => {},
        });
        await ctx.executor.remove(id, 'doomed.txt');
        await ctx.until(() => log.has('doomed.txt', 'remove'));

        await ctx.executor.move(id, 'old.txt', 'new.txt');
        await ctx.until(() => log.has('old.txt', 'rename'));
        await ctx.until(() => log.has('new.txt', 'create'));
        await watch.stop();
      },
      timeoutMs,
    );

    it(
      'subtree events reach a recursive watcher only, with subdir-relative names',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.makeDir(id, '/home/user/sub');
        const flat = eventLog();
        const deep = eventLog();
        const flatWatch = await ctx.executor.watchDir(id, {
          path: '/home/user',
          recursive: false,
          onEvent: flat.onEvent,
          onEnd: () => {},
        });
        const deepWatch = await ctx.executor.watchDir(id, {
          path: '/home/user',
          recursive: true,
          onEvent: deep.onEvent,
          onEnd: () => {},
        });
        await ctx.executor.writeFiles(id, [
          { path: 'sub/inner.txt', content: Buffer.from('deep') },
        ]);
        await ctx.until(() => deep.has('sub/inner.txt', 'create'));
        expect(flat.events).toEqual([]);
        await flatWatch.stop();
        await deepWatch.stop();
      },
      timeoutMs,
    );

    it(
      'a recursive watcher follows directories created after it started',
      async () => {
        // Measured under gVisor 2026-07-10: inotifywait -r adds watches for
        // directories born while it is running; the fake's prefix matching
        // gives the same answer.
        const id = await ctx.fresh();
        const log = eventLog();
        const watch = await ctx.executor.watchDir(id, {
          path: '/home/user',
          recursive: true,
          onEvent: log.onEvent,
          onEnd: () => {},
        });
        await ctx.executor.makeDir(id, '/home/user/born-later');
        await ctx.until(() => log.has('born-later', 'create'));
        await ctx.executor.writeFiles(id, [
          { path: 'born-later/inside.txt', content: Buffer.from('!') },
        ]);
        await ctx.until(() => log.has('born-later/inside.txt', 'create'));
        await watch.stop();
      },
      timeoutMs,
    );

    it(
      'stop() ends delivery; the watcher does not call onEnd for its own stop',
      async () => {
        const id = await ctx.fresh();
        const log = eventLog();
        let ended = false;
        const watch = await ctx.executor.watchDir(id, {
          path: '/home/user',
          recursive: false,
          onEvent: log.onEvent,
          onEnd: () => {
            ended = true;
          },
        });
        await watch.stop();
        await ctx.executor.writeFiles(id, [
          { path: 'after-stop.txt', content: Buffer.from('x') },
        ]);
        // Bounded quiet: nothing arrives for a change made after stop().
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(log.events).toEqual([]);
        expect(ended).toBe(false);
      },
      timeoutMs,
    );

    it(
      'watchDir refuses a missing path and a file path with the typed errors',
      async () => {
        const id = await ctx.fresh();
        const missing = await ctx.executor
          .watchDir(id, {
            path: '/home/user/nowhere',
            recursive: false,
            onEvent: () => {},
            onEnd: () => {},
          })
          .catch((e) => e);
        expect(missing).toBeInstanceOf(FileNotFoundError);
        expect(missing.message).toBe('no such file: /home/user/nowhere');

        await ctx.executor.writeFiles(id, [
          { path: 'plain.txt', content: Buffer.from('x') },
        ]);
        const onFile = await ctx.executor
          .watchDir(id, {
            path: 'plain.txt',
            recursive: false,
            onEvent: () => {},
            onEnd: () => {},
          })
          .catch((e) => e);
        expect(onFile).toBeInstanceOf(NotADirectoryError);
        expect(onFile.message).toBe('not a directory: /home/user/plain.txt');
      },
      timeoutMs,
    );

    it(
      'the container stopping ends the watcher through onEnd',
      async () => {
        const id = await ctx.fresh();
        let ended: Error | undefined;
        const watch = await ctx.executor.watchDir(id, {
          path: '/home/user',
          recursive: false,
          onEvent: () => {},
          onEnd: (error) => {
            ended = error ?? new Error('ended without error');
          },
        });
        await ctx.executor.freeze(id);
        await ctx.executor.stop(id);
        await ctx.until(() => ended !== undefined);
        // Ending was the container's doing, not stop()'s — which now finds
        // nothing left to do and must still resolve.
        await watch.stop();
      },
      timeoutMs,
    );

    it(
      'a watcher survives freeze/unfreeze and reports changes made after',
      async () => {
        const id = await ctx.fresh();
        const log = eventLog();
        const watch = await ctx.executor.watchDir(id, {
          path: '/home/user',
          recursive: false,
          onEvent: log.onEvent,
          onEnd: () => {},
        });
        await ctx.executor.freeze(id);
        await ctx.executor.unfreeze(id);
        await ctx.executor.writeFiles(id, [
          { path: 'thawed.txt', content: Buffer.from('back') },
        ]);
        await ctx.until(() => log.has('thawed.txt', 'create'));
        await watch.stop();
      },
      timeoutMs,
    );
  });
}
