import { describe, expect, it } from 'vitest';
import { LoginThrottle } from './login-throttle';

const T0 = 1_700_000_000_000;

describe('LoginThrottle', () => {
  it('allows the free failures without any delay', () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < 5; i++) {
      expect(throttle.retryAfterSeconds('ip', T0)).toBe(0);
      throttle.recordFailure('ip', T0);
    }
    expect(throttle.retryAfterSeconds('ip', T0)).toBe(0);
  });

  it('backs off exponentially past the free failures, capped', () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < 5; i++) throttle.recordFailure('ip', T0);
    throttle.recordFailure('ip', T0); // 6th: 1s
    expect(throttle.retryAfterSeconds('ip', T0)).toBe(1);
    throttle.recordFailure('ip', T0); // 7th: 2s
    expect(throttle.retryAfterSeconds('ip', T0)).toBe(2);
    for (let i = 0; i < 20; i++) throttle.recordFailure('ip', T0);
    // Deep in: capped at 5 minutes, never unbounded.
    expect(throttle.retryAfterSeconds('ip', T0)).toBe(300);
  });

  it('the delay drains with time', () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < 7; i++) throttle.recordFailure('ip', T0);
    expect(throttle.retryAfterSeconds('ip', T0 + 500)).toBe(2);
    expect(throttle.retryAfterSeconds('ip', T0 + 2_000)).toBe(0);
  });

  it('success clears the counter; keys are independent', () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < 8; i++) throttle.recordFailure('a', T0);
    expect(throttle.retryAfterSeconds('a', T0)).toBeGreaterThan(0);
    expect(throttle.retryAfterSeconds('b', T0)).toBe(0);
    throttle.clear('a');
    expect(throttle.retryAfterSeconds('a', T0)).toBe(0);
  });

  it('forgets idle counters after an hour', () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < 8; i++) throttle.recordFailure('ip', T0);
    const later = T0 + 61 * 60 * 1000;
    expect(throttle.retryAfterSeconds('ip', later)).toBe(0);
    // And the slate is genuinely clean: the next failure is a free one.
    throttle.recordFailure('ip', later);
    expect(throttle.retryAfterSeconds('ip', later)).toBe(0);
  });
});
