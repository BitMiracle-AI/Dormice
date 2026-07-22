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
  WatcherOperationConflictError,
  WatcherOperationLimitError,
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

  it('replays one operation sequentially and concurrently without another watcher', async () => {
    const pending = deferred<WatchDirHandle>();
    const executor = {
      watchDir: vi.fn(() => pending.promise),
    } as unknown as Executor;
    const table = new WatcherTable();
    const operationId = '11111111-1111-4111-8111-111111111111';

    const first = table.create({ ...args(executor), operationId });
    const concurrent = table.create({
      ...args(executor),
      path: '/home/user/./',
      operationId,
    });
    expect(executor.watchDir).toHaveBeenCalledTimes(1);
    expect(table.count('sandbox-1')).toBe(1);
    pending.resolve({ stop: async () => {} });

    const [watcherId, replayed] = await Promise.all([first, concurrent]);
    expect(replayed).toBe(watcherId);
    await expect(
      table.create({ ...args(executor), operationId }),
    ).resolves.toBe(watcherId);
    expect(executor.watchDir).toHaveBeenCalledTimes(1);
  });

  it('rejects an operation replay with a different canonical request', async () => {
    const executor = {
      watchDir: vi.fn().mockResolvedValue({ stop: async () => {} }),
    } as unknown as Executor;
    const table = new WatcherTable();
    const operationId = '22222222-2222-4222-8222-222222222222';
    const watcherId = await table.create({ ...args(executor), operationId });

    await expect(
      table.create({
        ...args(executor),
        path: '/home/user/other',
        operationId,
      }),
    ).rejects.toBeInstanceOf(WatcherOperationConflictError);
    await expect(
      table.create({ ...args(executor), recursive: true, operationId }),
    ).rejects.toBeInstanceOf(WatcherOperationConflictError);
    expect(table.drain('sandbox-1', watcherId)).toEqual([]);
    expect(executor.watchDir).toHaveBeenCalledTimes(1);
  });

  it('retains a live operation across expiry and prunes only its completed tombstone', async () => {
    let now = 0;
    const stop = vi.fn().mockResolvedValue(undefined);
    const executor = {
      watchDir: vi.fn().mockResolvedValue({ stop }),
    } as unknown as Executor;
    const table = new WatcherTable({
      now: () => now,
      operationRetentionMs: 10,
    });
    const operationId = '33333333-3333-4333-8333-333333333333';
    const watcherId = await table.create({ ...args(executor), operationId });

    now = 100;
    await expect(
      table.create({ ...args(executor), operationId }),
    ).resolves.toBe(watcherId);
    expect(executor.watchDir).toHaveBeenCalledTimes(1);

    await table.removeGoal('sandbox-1', watcherId);
    expect(table.count('sandbox-1')).toBe(0);
    expect(table.operationCount('sandbox-1')).toBe(1);
    await expect(
      table.create({ ...args(executor), operationId }),
    ).resolves.toBe(watcherId);

    now = 111;
    expect(table.operationCount('sandbox-1')).toBe(0);
    const replacement = await table.create({ ...args(executor), operationId });
    expect(replacement).not.toBe(watcherId);
    expect(executor.watchDir).toHaveBeenCalledTimes(2);
  });

  it('releases a failed operation and bounds retained operation state', async () => {
    const executor = {
      watchDir: vi
        .fn()
        .mockRejectedValueOnce(new Error('start failed'))
        .mockResolvedValue({ stop: async () => {} }),
    } as unknown as Executor;
    const table = new WatcherTable({ maxOperationsPerSandbox: 1 });
    const firstId = '44444444-4444-4444-8444-444444444444';
    await expect(
      table.create({ ...args(executor), operationId: firstId }),
    ).rejects.toThrow('start failed');
    expect(table.operationCount('sandbox-1')).toBe(0);
    await table.create({ ...args(executor), operationId: firstId });

    await expect(
      table.create({
        ...args(executor),
        operationId: '55555555-5555-4555-8555-555555555555',
      }),
    ).rejects.toBeInstanceOf(WatcherOperationLimitError);
  });

  it('makes repeated and cross-sandbox goal removal converge without another stop', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const executor = {
      watchDir: vi.fn().mockResolvedValue({ stop }),
    } as unknown as Executor;
    const table = new WatcherTable();
    const id = await table.create(args(executor));

    await table.removeGoal('sandbox-2', id);
    expect(stop).not.toHaveBeenCalled();
    await Promise.all([
      table.removeGoal('sandbox-1', id),
      table.removeGoal('sandbox-1', id),
    ]);
    await table.removeGoal('sandbox-1', id);
    await table.removeGoal('sandbox-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('reserves streaming capacity before physical start and releases a refused wake', () => {
    const table = new WatcherTable();
    for (let index = 0; index < MAX_WATCHERS_PER_SANDBOX; index++) {
      table.reserveStreaming('sandbox-1');
    }
    expect(() => table.reserveStreaming('sandbox-1')).toThrow(
      WatcherLimitError,
    );

    table.disposeSandbox('sandbox-1');
    expect(table.count('sandbox-1')).toBe(0);
    const reservation = table.reserveStreaming('sandbox-1');
    table.cancelStreamingReservation('sandbox-1', reservation);
    expect(table.count('sandbox-1')).toBe(0);
  });

  it('owns failed streaming cleanup until a legitimate reap succeeds', async () => {
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('signal failed'))
      .mockResolvedValueOnce(undefined);
    const executor = {
      watchDir: vi.fn().mockResolvedValue({ stop }),
    } as unknown as Executor;
    const table = new WatcherTable();
    const id = await table.createStreaming({
      ...args(executor),
      onEvent: async () => {},
      onEnd: vi.fn(),
    });

    await expect(
      table.closeStreaming('sandbox-1', id, { runnable: true }),
    ).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(table.count('sandbox-1')).toBe(0);
  });

  it('keeps cold streaming cleanup deferred until a legitimate reap', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const executor = {
      watchDir: vi.fn().mockResolvedValue({ stop }),
    } as unknown as Executor;
    const table = new WatcherTable();
    const id = await table.createStreaming({
      ...args(executor),
      onEvent: async () => {},
      onEnd: vi.fn(),
    });

    await table.closeStreaming('sandbox-1', id, { runnable: false });
    expect(stop).not.toHaveBeenCalled();
    expect(table.count('sandbox-1')).toBe(1);

    await table.reapDeferred('sandbox-1');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(table.count('sandbox-1')).toBe(0);
  });

  it('ends every streaming route before shutdown waits for physical stops', async () => {
    const secondStop = deferred<void>();
    const stop = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => secondStop.promise);
    const onEnd = vi.fn();
    const executor = {
      watchDir: vi.fn().mockResolvedValue({ stop }),
    } as unknown as Executor;
    const table = new WatcherTable();
    await table.createStreaming({
      ...args(executor),
      onEvent: async () => {},
      onEnd,
    });

    table.disposeSandbox('sandbox-1');
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(table.count('sandbox-1')).toBe(0);

    const shutdownEnd = vi.fn();
    await table.createStreaming({
      ...args(executor),
      onEvent: async () => {},
      onEnd: shutdownEnd,
    });
    const pendingEnd = vi.fn();
    await table.createStreaming({
      ...args(executor),
      path: '/home/user/other',
      onEvent: async () => {},
      onEnd: pendingEnd,
    });

    const shutdown = table.shutdown();
    expect(shutdownEnd).toHaveBeenCalledTimes(1);
    expect(pendingEnd).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(2);
    secondStop.resolve();
    await shutdown;
  });

  it('drops an operation binding when container death makes its watcher unrecoverable', async () => {
    const executor = {
      watchDir: vi.fn().mockResolvedValue({ stop: async () => {} }),
    } as unknown as Executor;
    const table = new WatcherTable();
    const operationId = '66666666-6666-4666-8666-666666666666';
    const before = await table.create({ ...args(executor), operationId });

    table.disposeSandbox('sandbox-1');
    const after = await table.create({ ...args(executor), operationId });

    expect(after).not.toBe(before);
    expect(executor.watchDir).toHaveBeenCalledTimes(2);
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
