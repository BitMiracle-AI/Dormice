import { describe, expect, it, vi } from 'vitest';
import { WatchProcessLifecycle } from './watch-lifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const cleanExit = { exitCode: 137, error: undefined };

describe('WatchProcessLifecycle', () => {
  it('suppresses onEnd when the process exits during explicit stop', async () => {
    const exited = deferred<typeof cleanExit>();
    const onNaturalEnd = vi.fn();
    const lifecycle = new WatchProcessLifecycle({
      exit: exited.promise,
      stopProcess: async () => exited.resolve(cleanExit),
      classifyFailedStop: async () => 'retry',
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
      classifyFailedStop: async () => 'retry',
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
      classifyFailedStop: async () => 'retry',
      onNaturalEnd,
    });

    await expect(lifecycle.stop()).rejects.toThrow('docker exec unavailable');
    expect(lifecycle.delivering).toBe(true);
    await lifecycle.stop();

    expect(stopProcess).toHaveBeenCalledTimes(2);
    expect(onNaturalEnd).not.toHaveBeenCalled();
  });

  it('keeps cleanup retryable when signal and container inspection both fail', async () => {
    const exited = deferred<typeof cleanExit>();
    const signalError = new Error('docker exec unavailable');
    const inspectError = new Error('docker socket unavailable');
    const stopProcess = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(signalError)
      .mockImplementationOnce(async () => exited.resolve(cleanExit));
    const onNaturalEnd = vi.fn();
    const lifecycle = new WatchProcessLifecycle({
      exit: exited.promise,
      stopProcess,
      classifyFailedStop: vi.fn().mockRejectedValue(inspectError),
      onNaturalEnd,
    });

    const failed = lifecycle.stop().catch((error) => error);
    await expect(failed).resolves.toMatchObject({
      message: 'watcher stop failed and container state is unknown',
      errors: [signalError, inspectError],
    });
    expect(lifecycle.delivering).toBe(true);
    await lifecycle.stop();

    expect(stopProcess).toHaveBeenCalledTimes(2);
    expect(onNaturalEnd).not.toHaveBeenCalled();
  });

  it('settles when process exit wins while failed-stop inspection is pending', async () => {
    const exited = deferred<typeof cleanExit>();
    const inspected = deferred<'retry'>();
    const onNaturalEnd = vi.fn();
    const lifecycle = new WatchProcessLifecycle({
      exit: exited.promise,
      stopProcess: vi.fn().mockRejectedValue(new Error('signal failed')),
      classifyFailedStop: () => inspected.promise,
      onNaturalEnd,
    });

    const stopping = lifecycle.stop();
    exited.resolve(cleanExit);
    await Promise.resolve();
    inspected.reject(new Error('inspect failed'));
    await stopping;

    expect(lifecycle.delivering).toBe(false);
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
      classifyFailedStop: async () => 'terminal',
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
    const inspected = deferred<'terminal'>();
    const stopProcess = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('container paused'));
    const lifecycle = new WatchProcessLifecycle({
      exit: exited.promise,
      stopProcess,
      classifyFailedStop: () => inspected.promise,
      onNaturalEnd: vi.fn(),
    });

    const first = lifecycle.stop();
    const second = lifecycle.stop();
    expect(second).toBe(first);
    inspected.resolve('terminal');
    await Promise.all([first, second]);

    expect(stopProcess).toHaveBeenCalledTimes(1);
  });

  it('reports a natural exit exactly once', async () => {
    const exited = deferred<typeof cleanExit>();
    const onNaturalEnd = vi.fn();
    const lifecycle = new WatchProcessLifecycle({
      exit: exited.promise,
      stopProcess: vi.fn(),
      classifyFailedStop: async () => 'retry',
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
