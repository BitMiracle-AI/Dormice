import { DEFAULT_LIFECYCLE_POLICY } from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { resolvePolicy } from './policy';

describe('resolvePolicy', () => {
  it('returns the global defaults when no override is given', () => {
    expect(resolvePolicy()).toEqual(DEFAULT_LIFECYCLE_POLICY);
    expect(resolvePolicy({})).toEqual(DEFAULT_LIFECYCLE_POLICY);
  });

  it('merges a partial override over the defaults', () => {
    expect(resolvePolicy({ freezeAfterSeconds: 60 })).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      freezeAfterSeconds: 60,
    });
  });

  it('keeps an explicit null for archiveAfterSeconds (never archive)', () => {
    expect(
      resolvePolicy({ archiveAfterSeconds: null }).archiveAfterSeconds,
    ).toBeNull();
  });

  it('rejects a merged result that violates freeze <= stop', () => {
    // Default stopAfterSeconds is 3 days; a freeze threshold beyond it must fail.
    expect(() =>
      resolvePolicy({
        freezeAfterSeconds: DEFAULT_LIFECYCLE_POLICY.stopAfterSeconds + 1,
      }),
    ).toThrow(/freezeAfterSeconds/);
  });

  it('rejects a merged result that violates stop <= archive', () => {
    expect(() => resolvePolicy({ archiveAfterSeconds: 1 })).toThrow(
      /stopAfterSeconds/,
    );
  });
});
