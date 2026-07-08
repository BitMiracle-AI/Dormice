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
    expect(() =>
      resolvePolicy({ freezeAfterSeconds: 61, stopAfterSeconds: 60 }),
    ).toThrow(/freezeAfterSeconds/);
  });

  it('rejects a merged result that violates stop <= archive', () => {
    // Default stopAfterSeconds is 3 days; archiving after 1s must fail.
    expect(() => resolvePolicy({ archiveAfterSeconds: 1 })).toThrow(
      /stopAfterSeconds/,
    );
  });

  it('keeps an explicit null for stopAfterSeconds (never stop)', () => {
    // The resident-agent policy: park frozen forever, wake in ~50ms, never
    // decay to a cold boot.
    expect(
      resolvePolicy({ stopAfterSeconds: null }).stopAfterSeconds,
    ).toBeNull();
  });

  it('rejects archiving a sandbox that never stops', () => {
    expect(() =>
      resolvePolicy({ stopAfterSeconds: null, archiveAfterSeconds: 60 }),
    ).toThrow(/archiveAfterSeconds requires a stopAfterSeconds/);
  });
});
