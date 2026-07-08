import { describe, expect, it } from 'vitest';
import { KeyedQueue, SKIPPED } from './keyed-queue';

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe('KeyedQueue.run', () => {
  it('serializes tasks on the same key: never two in flight at once', async () => {
    const queue = new KeyedQueue();
    let active = 0;
    let peak = 0;
    const task = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    };
    await Promise.all([
      queue.run('k', task),
      queue.run('k', task),
      queue.run('k', task),
    ]);
    expect(peak).toBe(1);
  });

  it('runs tasks in the order they were queued', async () => {
    const queue = new KeyedQueue();
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        queue.run('k', async () => {
          order.push(n);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it('lets different keys run concurrently', async () => {
    const queue = new KeyedQueue();
    const a = gate();
    let bRan = false;
    // a's task blocks until we open the gate; b must not wait for it.
    const aTask = queue.run('a', () => a.opened);
    await queue.run('b', async () => {
      bRan = true;
    });
    expect(bRan).toBe(true);
    a.open();
    await aTask;
  });

  it('returns the task result and propagates its rejection', async () => {
    const queue = new KeyedQueue();
    await expect(queue.run('k', async () => 42)).resolves.toBe(42);
    await expect(
      queue.run('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('a rejected task does not block the next one on the same key', async () => {
    const queue = new KeyedQueue();
    await queue
      .run('k', () => Promise.reject(new Error('boom')))
      .catch(() => {
        // The rejection belongs to this caller alone.
      });
    await expect(queue.run('k', async () => 'after')).resolves.toBe('after');
  });
});

describe('KeyedQueue.tryRun', () => {
  it('skips when the key is busy, runs once it is free again', async () => {
    const queue = new KeyedQueue();
    const busy = gate();
    const holder = queue.run('k', () => busy.opened);

    expect(await queue.tryRun('k', async () => 'ran')).toBe(SKIPPED);

    busy.open();
    await holder;
    expect(await queue.tryRun('k', async () => 'ran')).toBe('ran');
  });

  it('does not consider other keys busy', async () => {
    const queue = new KeyedQueue();
    const busy = gate();
    const holder = queue.run('a', () => busy.opened);
    expect(await queue.tryRun('b', async () => 'ran')).toBe('ran');
    busy.open();
    await holder;
  });
});
