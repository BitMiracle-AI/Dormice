import { describe, expect, it, vi } from 'vitest';
import { EnvdError, type EnvdWatchEvent } from '../envd-client';
import {
  DirectoryWatcherController,
  type DirectoryWatcherDeps,
} from './directory-watcher';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(overrides: Partial<DirectoryWatcherDeps> = {}) {
  const create = vi.fn<() => Promise<string>>().mockResolvedValue('watch-1');
  const poll = vi
    .fn<(id: string) => Promise<EnvdWatchEvent[]>>()
    .mockResolvedValue([]);
  const remove = vi.fn<(id: string) => Promise<void>>().mockResolvedValue();
  const onDirty = vi.fn();
  let active = true;
  const controller = new DirectoryWatcherController({
    create,
    poll,
    remove,
    isActive: () => active,
    isNotFound: (error) =>
      error instanceof EnvdError && error.code === 'not_found',
    onDirty,
    ...overrides,
  });
  return {
    controller,
    create,
    poll,
    remove,
    onDirty,
    setActive(value: boolean) {
      active = value;
    },
  };
}

describe('DirectoryWatcherController', () => {
  it('removes the watcher exactly once after normal disposal', async () => {
    const t = harness();
    await t.controller.tick();
    t.controller.dispose();
    t.controller.dispose();
    await vi.waitFor(() => expect(t.remove).toHaveBeenCalledWith('watch-1'));
    expect(t.remove).toHaveBeenCalledTimes(1);
  });

  it('retires an ID returned after disposal', async () => {
    const pending = deferred<string>();
    const t = harness({ create: () => pending.promise });
    const tick = t.controller.tick();
    t.controller.dispose();
    pending.resolve('late');
    await tick;
    expect(t.remove).toHaveBeenCalledWith('late');
  });

  it('keeps create single-flight across repeated timer ticks', async () => {
    const pending = deferred<string>();
    const create = vi.fn(() => pending.promise);
    const t = harness({ create });
    const first = t.controller.tick();
    const second = t.controller.tick();
    expect(create).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    pending.resolve('slow');
    await first;
  });

  it('does not arm while inactive and preserves an existing watcher through freeze', async () => {
    const t = harness();
    t.setActive(false);
    await t.controller.tick();
    expect(t.create).not.toHaveBeenCalled();

    t.setActive(true);
    await t.controller.tick();
    t.setActive(false);
    await t.controller.tick();
    expect(t.poll).toHaveBeenCalledWith('watch-1');
    expect(t.create).toHaveBeenCalledTimes(1);
  });

  it('retains the watcher after a transient poll error', async () => {
    const t = harness();
    await t.controller.tick();
    t.poll.mockRejectedValueOnce(new Error('temporary network failure'));
    await t.controller.tick();
    await t.controller.tick();
    expect(t.poll).toHaveBeenCalledTimes(2);
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(t.onDirty).toHaveBeenCalledTimes(1);
  });

  it('reports events while frozen without creating another watcher', async () => {
    const t = harness();
    await t.controller.tick();
    t.setActive(false);
    t.poll.mockResolvedValueOnce([
      { name: 'queued.txt', type: 'EVENT_TYPE_CREATE' },
    ]);
    await t.controller.tick();
    expect(t.onDirty).toHaveBeenCalledWith(false);
    expect(t.create).toHaveBeenCalledTimes(1);
  });

  it('refreshes once after a dirty frozen watcher becomes active again', async () => {
    const t = harness();
    await t.controller.tick();
    t.setActive(false);
    t.poll.mockResolvedValueOnce([
      { name: 'queued.txt', type: 'EVENT_TYPE_CREATE' },
    ]);
    await t.controller.tick();

    t.setActive(true);
    await t.controller.tick();
    await t.controller.tick();

    expect(t.onDirty.mock.calls).toEqual([[false], [true]]);
  });

  it('rearms only after a confirmed not_found response', async () => {
    const t = harness();
    t.create.mockResolvedValueOnce('old').mockResolvedValueOnce('new');
    await t.controller.tick();
    t.poll.mockRejectedValueOnce(new EnvdError('gone', 'not_found', 404));
    await t.controller.tick();
    await t.controller.tick();
    expect(t.create).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate or rearm after disposal during a poll', async () => {
    const pending = deferred<EnvdWatchEvent[]>();
    const t = harness({ poll: () => pending.promise });
    await t.controller.tick();
    const polling = t.controller.tick();
    t.controller.dispose();
    pending.resolve([{ name: 'late.txt', type: 'EVENT_TYPE_CREATE' }]);
    await polling;
    await t.controller.tick();
    expect(t.onDirty).not.toHaveBeenCalled();
    expect(t.create).toHaveBeenCalledTimes(1);
  });

  it('isolates rapid effect generations', async () => {
    const oldCreate = deferred<string>();
    const old = harness({ create: () => oldCreate.promise });
    const oldTick = old.controller.tick();
    old.controller.dispose();

    const next = harness({ create: async () => 'new' });
    await next.controller.tick();
    oldCreate.resolve('old');
    await oldTick;

    expect(old.remove).toHaveBeenCalledWith('old');
    expect(next.remove).not.toHaveBeenCalled();
  });
});
