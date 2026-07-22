import { describe, expect, it, vi } from 'vitest';
import { WatchProcessLifecycle } from './watch-lifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const cleanExit = { exitCode: 137, error: undefined };

describe('WatchProcessLifecycle', () => {
  it('suppresses onEnd when the process exits during explicit stop', async () => {
    const exited = deferred<typeof cleanExit>();
    const onNaturalEnd = vi.fn();
    const lifecycle = new WatchProcessLifecycle({
      exit: exited.promise,
      stopProcess: async () => exited.resolve(cleanExit),
      canRetryStop: async () => true,
      onNaturalEnd,
    });

    await lifecycle.stop();

    expect(onNaturalEnd).not.toHaveBeenCalled();
    expect(lifecycle.delivering).toBe(false);
  });

  it('shares one physical stop attempt across concurrent callers', async () => {
    const exited = deferred<typeof cleanExit>();
    const signaled = deferred<void>();
    const stopProcess = vi.fn(() => signaled.promise);
    const lifecycle = new WatchProcessLifecycle({
      exit: exited.promise,
      stopProcess,
      canRetryStop: async () => true,
      onNaturalEnd: vi.fn(),
    });

    const first = lifecycle.stop();
    const second = lifecycle.stop();
    await vi.waitFor(() => expect(stopProcess).toHaveBeenCalledTimes(1));
    expect(second).toBe(first);
    signaled.resolve();
    exited.resolve(cleanExit);
    await first;
  });

  it('hands ownership back after a runnable transient signal failure', async () => {
    const exited = deferred<typeof cleanExit>();
    const onNaturalEnd = vi.fn();
    const stopProcess = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('docker exec unavailable'))
      .mockImplementationOnce(async () => exited.resolve(cleanExit));
    const lifecycle = new WatchProcessLifecycle({
      exit: exited.promise,
      stopProcess,
      canRetryStop: async () => true,
      onNaturalEnd,
    });

    await expect(lifecycle.stop()).rejects.toThrow('docker exec unavailable');
    expect(lifecycle.delivering).toBe(true);
    await lifecycle.stop();

    expect(stopProcess).toHaveBeenCalledTimes(2);
    expect(onNaturalEnd).not.toHaveBeenCalled();
  });

  it('settles cleanup when a failed signal finds the container unavailable', async () => {
    const exited = deferred<typeof cleanExit>();
    const onNaturalEnd = vi.fn();
    const lifecycle = new WatchProcessLifecycle({
      exit: exited.promise,
      stopProcess: async () => {
        throw new Error('container paused');
      },
      canRetryStop: async () => false,
      onNaturalEnd,
    });

    await lifecycle.stop();
    exited.resolve(cleanExit);
    await Promise.resolve();

    expect(lifecycle.delivering).toBe(false);
    expect(onNaturalEnd).not.toHaveBeenCalled();
  });

  it('makes a later stop observe an in-progress non-retryable cleanup', async () => {
    const exited = deferred<typeof cleanExit>();
    const inspected = deferred<boolean>();
    const stopProcess = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('container paused'));
    const lifecycle = new WatchProcessLifecycle({
      exit: exited.promise,
      stopProcess,
      canRetryStop: () => inspected.promise,
      onNaturalEnd: vi.fn(),
    });

    const first = lifecycle.stop();
    const second = lifecycle.stop();
    expect(second).toBe(first);
    inspected.resolve(false);
    await Promise.all([first, second]);

    expect(stopProcess).toHaveBeenCalledTimes(1);
  });

  it('reports a natural exit exactly once', async () => {
    const exited = deferred<typeof cleanExit>();
    const onNaturalEnd = vi.fn();
    const lifecycle = new WatchProcessLifecycle({
      exit: exited.promise,
      stopProcess: vi.fn(),
      canRetryStop: async () => true,
      onNaturalEnd,
    });

    exited.resolve(cleanExit);
    await vi.waitFor(() =>
      expect(onNaturalEnd).toHaveBeenCalledWith(cleanExit),
    );
    await lifecycle.stop();

    expect(onNaturalEnd).toHaveBeenCalledTimes(1);
  });
});
