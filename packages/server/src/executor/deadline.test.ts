import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deadline } from './deadline';

describe('deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes a resolution through untouched', async () => {
    await expect(deadline(Promise.resolve(42), 1, 'op')).resolves.toBe(42);
  });

  it('passes a rejection through untouched', async () => {
    await expect(
      deadline(Promise.reject(new Error('boom')), 1, 'op'),
    ).rejects.toThrow('boom');
  });

  it('rejects with a named error once the deadline passes', async () => {
    const lost = deadline(new Promise<never>(() => {}), 30, 'pause of sbx-1');
    const outcome = expect(lost).rejects.toThrow(
      'pause of sbx-1 got no answer from dockerd within 30s',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
  });

  it('does not fire after the work already settled', async () => {
    await expect(deadline(Promise.resolve('ok'), 1, 'op')).resolves.toBe('ok');
    // The timer was cleared; advancing past the deadline must be a no-op
    // (an uncleared timer would reject an already-settled race — harmless
    // to the caller but an unhandled rejection crashing the daemon).
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it('hands a result that lands after the deadline to release', async () => {
    let answer!: (value: string) => void;
    const work = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const released: string[] = [];
    const lost = deadline(work, 1, 'exec start', (late) => released.push(late));
    const outcome = expect(lost).rejects.toThrow('got no answer');
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    // Nobody is left to use it: a late attach stream nobody reads is what
    // dockerd blocks on.
    answer('stream');
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toEqual(['stream']);
  });

  it('never releases a result that won the race', async () => {
    const released: string[] = [];
    await expect(
      deadline(Promise.resolve('stream'), 1, 'op', (late) =>
        released.push(late),
      ),
    ).resolves.toBe('stream');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(released).toEqual([]);
  });

  it('swallows a late rejection from the losing work', async () => {
    let reject!: (err: Error) => void;
    const work = new Promise<never>((_, rej) => {
      reject = rej;
    });
    const lost = deadline(work, 1, 'op');
    // Handler on before the clock moves — a rejection nobody has subscribed
    // to yet would itself count as unhandled and fail the run.
    const outcome = expect(lost).rejects.toThrow('got no answer');
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    // The loser rejecting after the race settled must not surface as an
    // unhandled rejection — vitest turns those into test failures.
    reject(new Error('late'));
    await vi.advanceTimersByTimeAsync(0);
  });
});
