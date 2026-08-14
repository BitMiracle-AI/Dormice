import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Watchdog } from './watchdog';

describe('Watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = (onStall: (ms: number) => void) =>
    new Watchdog({
      stallAfterMs: 10 * 60_000,
      checkEveryMs: 60_000,
      onStall,
    });

  it('bites after the stall limit passes without a beat', () => {
    const onStall = vi.fn();
    const dog = make(onStall);
    dog.start();
    vi.advanceTimersByTime(9 * 60_000);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(onStall).toHaveBeenCalledOnce();
    expect(onStall.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it('beats keep it quiet through a long, progressing sweep', () => {
    const onStall = vi.fn();
    const dog = make(onStall);
    dog.start();
    // An hour of work, beating every 5 minutes — never 10 quiet minutes.
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(5 * 60_000);
      dog.beat();
    }
    expect(onStall).not.toHaveBeenCalled();
  });

  it('bites exactly once', () => {
    const onStall = vi.fn();
    const dog = make(onStall);
    dog.start();
    vi.advanceTimersByTime(60 * 60_000);
    expect(onStall).toHaveBeenCalledOnce();
  });

  it('stop() disarms it', () => {
    const onStall = vi.fn();
    const dog = make(onStall);
    dog.start();
    dog.stop();
    vi.advanceTimersByTime(60 * 60_000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('start() after stop() re-arms from a fresh beat', () => {
    const onStall = vi.fn();
    const dog = make(onStall);
    dog.start();
    vi.advanceTimersByTime(9 * 60_000);
    dog.stop();
    dog.start();
    vi.advanceTimersByTime(9 * 60_000);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(onStall).toHaveBeenCalledOnce();
  });
});
