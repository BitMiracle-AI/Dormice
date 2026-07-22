import { describe, expect, it, vi } from 'vitest';
import type {
  Executor,
  WatchDirHandle,
  WatchDirOptions,
} from '../executor/executor';
import { WatchProcessLifecycle } from '../executor/watch-lifecycle';
import {
  MAX_WATCHERS_PER_SANDBOX,
  WatcherLimitError,
  WatcherTable,
} from './watcher-table';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const args = (executor: Executor) => ({
  executor,
  sandboxId: 'sandbox-1',
  path: '/home/user',
  recursive: false,
});

describe('WatcherTable', () => {
  it('reserves capacity before concurrent starts complete', async () => {
    const pending: Array<ReturnType<typeof deferred<WatchDirHandle>>> = [];
    const executor = {
      watchDir: vi.fn((_id: string, _opts: WatchDirOptions) => {
        const next = deferred<WatchDirHandle>();
        pending.push(next);
        return next.promise;
      }),
    } as unknown as Executor;
    const table = new WatcherTable();
    const starts = Array.from({ length: MAX_WATCHERS_PER_SANDBOX }, () =>
      table.create(args(executor)),
    );

    await expect(table.create(args(executor))).rejects.toBeInstanceOf(
      WatcherLimitError,
    );
    expect(executor.watchDir).toHaveBeenCalledTimes(MAX_WATCHERS_PER_SANDBOX);
    for (const item of pending) item.resolve({ stop: async () => {} });
    await Promise.all(starts);
  });

  it('releases a reservation when start fails', async () => {
    const executor = {
      watchDir: vi.fn().mockRejectedValueOnce(new Error('start failed')),
    } as unknown as Executor;
    const table = new WatcherTable();

    await expect(table.create(args(executor))).rejects.toThrow('start failed');
    expect(table.count('sandbox-1')).toBe(0);
  });

  it('does not publish an ID when onEnd wins during startup', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const executor = {
      watchDir: vi.fn(async (_id: string, opts: WatchDirOptions) => {
        opts.onEnd(new Error('died while starting'));
        return { stop };
      }),
    } as unknown as Executor;
    const table = new WatcherTable();

    await expect(table.create(args(executor))).rejects.toThrow(
      'died while starting',
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(table.count('sandbox-1')).toBe(0);
  });

  it('finalizes explicit removal exactly once when onEnd races it', async () => {
    let onEnd!: WatchDirOptions['onEnd'];
    const stop = vi.fn(async () => onEnd(new Error('ended')));
    const executor = {
      watchDir: vi.fn(async (_id: string, opts: WatchDirOptions) => {
        onEnd = opts.onEnd;
        return { stop };
      }),
    } as unknown as Executor;
    const table = new WatcherTable();
    const id = await table.create(args(executor));

    await expect(table.remove('sandbox-1', id)).resolves.toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(table.count('sandbox-1')).toBe(0);
    await expect(table.remove('sandbox-1', id)).resolves.toBe(false);
  });

  it('shares one physical stop across concurrent cleanup paths', async () => {
    const pending = deferred<void>();
    const stop = vi.fn(() => pending.promise);
    const executor = {
      watchDir: vi.fn().mockResolvedValue({ stop }),
    } as unknown as Executor;
    const table = new WatcherTable();
    const id = await table.create(args(executor));
    table.retire('sandbox-1', id);

    const first = table.remove('sandbox-1', id);
    const second = table.reapRetired('sandbox-1');
    expect(stop).toHaveBeenCalledTimes(1);
    pending.resolve();
    await Promise.all([first, second]);
    expect(table.count('sandbox-1')).toBe(0);
  });

  it('keeps a failed active removal retired and retries on the next use', async () => {
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('signal did not land'))
      .mockResolvedValueOnce(undefined);
    const executor = {
      watchDir: vi.fn().mockResolvedValue({ stop }),
    } as unknown as Executor;
    const table = new WatcherTable();
    const id = await table.create(args(executor));

    await expect(table.remove('sandbox-1', id)).rejects.toThrow(
      'signal did not land',
    );
    expect(table.count('sandbox-1')).toBe(1);
    expect(table.drain('sandbox-1', id)).toBeUndefined();
    await expect(table.reapRetired('sandbox-1')).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(table.count('sandbox-1')).toBe(0);
  });

  it('retains the record when signal and inspection fail, then reaps it', async () => {
    const exited = deferred<{ exitCode: number; error: undefined }>();
    const stopProcess = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('signal failed'))
      .mockImplementationOnce(async () =>
        exited.resolve({ exitCode: 137, error: undefined }),
      );
    const lifecycle = new WatchProcessLifecycle({
      exit: exited.promise,
      stopProcess,
      classifyFailedStop: vi
        .fn()
        .mockRejectedValue(new Error('inspect failed')),
      onNaturalEnd: vi.fn(),
    });
    const executor = {
      watchDir: vi.fn().mockResolvedValue({ stop: () => lifecycle.stop() }),
    } as unknown as Executor;
    const table = new WatcherTable();
    const id = await table.create(args(executor));

    await expect(table.remove('sandbox-1', id)).rejects.toThrow(
      'container state is unknown',
    );
    expect(table.count('sandbox-1')).toBe(1);
    expect(table.drain('sandbox-1', id)).toBeUndefined();

    await table.reapRetired('sandbox-1');
    expect(stopProcess).toHaveBeenCalledTimes(2);
    expect(table.count('sandbox-1')).toBe(0);
  });

  it('retires without stopping, then reaps after a legitimate wake', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const executor = {
      watchDir: vi.fn().mockResolvedValue({ stop }),
    } as unknown as Executor;
    const table = new WatcherTable();
    const id = await table.create(args(executor));

    expect(table.retire('sandbox-1', id)).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(table.drain('sandbox-1', id)).toBeUndefined();
    expect(table.count('sandbox-1')).toBe(1);

    await table.reapRetired('sandbox-1');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(table.count('sandbox-1')).toBe(0);
  });

  it('keeps watcher IDs scoped to their sandbox', async () => {
    const executor = {
      watchDir: vi.fn().mockResolvedValue({ stop: async () => {} }),
    } as unknown as Executor;
    const table = new WatcherTable();
    const id = await table.create(args(executor));

    expect(table.drain('sandbox-2', id)).toBeUndefined();
    expect(table.retire('sandbox-2', id)).toBe(false);
    await expect(table.remove('sandbox-2', id)).resolves.toBe(false);
  });
});
