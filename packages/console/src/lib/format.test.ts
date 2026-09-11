import { describe, expect, it } from 'vitest';

import { formatBytes, pctOf } from './format';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1.00 KiB'],
    [1536, '1.50 KiB'],
    [10 * 1024, '10.0 KiB'],
    [100 * 1024, '100 KiB'],
    // Regression: rounding used to push these to the "1024 <unit>" string
    // even though every element in the string exists at the next unit.
    // Each value is one unit below the next power of 1024 by 276 sub-units —
    // enough that toFixed(0) rounds the display up to 1024 without the check.
    [1048300, '1.00 MiB'],
    [1073459200, '1.00 GiB'],
    [1099509530624, '1.00 TiB'],
  ])('formats %s as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it('never prints 1024 of any unit', () => {
    // Sweep every unit boundary from the half-KiB below through the boundary.
    const boundaries = [1024, 1024 ** 2, 1024 ** 3, 1024 ** 4, 1024 ** 5];
    for (const boundary of boundaries) {
      for (let delta = 0; delta < 600; delta += 1) {
        const bytes = boundary - delta;
        expect(formatBytes(bytes)).not.toMatch(/^1024 /);
      }
    }
  });

  it('handles non-finite and negative inputs', () => {
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('pctOf', () => {
  it('clamps to [0, 100]', () => {
    expect(pctOf(0, 100)).toBe(0);
    expect(pctOf(50, 100)).toBe(50);
    expect(pctOf(150, 100)).toBe(100);
    expect(pctOf(-1, 100)).toBe(0);
  });

  it('returns 0 for a non-positive total', () => {
    expect(pctOf(5, 0)).toBe(0);
    expect(pctOf(5, -10)).toBe(0);
  });
});
