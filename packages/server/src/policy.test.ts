import { DEFAULT_LIFECYCLE_POLICY } from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { ARCHIVE_DEFAULT_SECONDS, resolvePolicy } from './policy';

describe('resolvePolicy without an archiver (archiveDefaultSeconds = null)', () => {
  it('returns the global defaults when no override is given', () => {
    expect(resolvePolicy(undefined, null)).toEqual(DEFAULT_LIFECYCLE_POLICY);
    expect(resolvePolicy({}, null)).toEqual(DEFAULT_LIFECYCLE_POLICY);
  });

  it('merges a partial override over the defaults', () => {
    expect(resolvePolicy({ freezeAfterSeconds: 60 }, null)).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      freezeAfterSeconds: 60,
    });
  });

  it('keeps an explicit null for archiveAfterSeconds (never archive)', () => {
    expect(
      resolvePolicy({ archiveAfterSeconds: null }, null).archiveAfterSeconds,
    ).toBeNull();
  });

  it('refuses an explicit archive threshold — no archiver, no promise', () => {
    expect(() => resolvePolicy({ archiveAfterSeconds: 60 }, null)).toThrow(
      /archiving requires S3 \(DORMICE_S3_\*\) to be configured/,
    );
  });

  it('rejects a merged result that violates freeze <= stop', () => {
    expect(() =>
      resolvePolicy({ freezeAfterSeconds: 61, stopAfterSeconds: 60 }, null),
    ).toThrow(/freezeAfterSeconds/);
  });

  it('keeps an explicit null for stopAfterSeconds (never stop)', () => {
    // The resident-agent policy: park frozen forever, wake in ~50ms, never
    // decay to a cold boot.
    expect(
      resolvePolicy({ stopAfterSeconds: null }, null).stopAfterSeconds,
    ).toBeNull();
  });
});

describe('resolvePolicy with an archiver (archiveDefaultSeconds = 7 days)', () => {
  it('defaults new sandboxes to archiving after a week', () => {
    expect(resolvePolicy(undefined, ARCHIVE_DEFAULT_SECONDS)).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      archiveAfterSeconds: ARCHIVE_DEFAULT_SECONDS,
    });
  });

  it('keeps an explicit null for archiveAfterSeconds (never archive)', () => {
    expect(
      resolvePolicy({ archiveAfterSeconds: null }, ARCHIVE_DEFAULT_SECONDS)
        .archiveAfterSeconds,
    ).toBeNull();
  });

  it('never archives a never-stop sandbox — the default yields to the override', () => {
    // Only a stopped sandbox can archive; a stop:null override with the
    // 7-day default left in place would be an invalid policy, so the
    // default steps aside instead of turning the override into a 400.
    expect(
      resolvePolicy({ stopAfterSeconds: null }, ARCHIVE_DEFAULT_SECONDS),
    ).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      stopAfterSeconds: null,
      archiveAfterSeconds: null,
    });
  });

  it('a stop pushed past the default drags the archive default along', () => {
    // Same yielding rule: an explicit 30-day stop must not collide with the
    // 7-day archive default — archiving then begins when stopping does.
    const thirtyDays = 30 * 24 * 60 * 60;
    expect(
      resolvePolicy({ stopAfterSeconds: thirtyDays }, ARCHIVE_DEFAULT_SECONDS),
    ).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      stopAfterSeconds: thirtyDays,
      archiveAfterSeconds: thirtyDays,
    });
  });

  it('rejects an explicit archive threshold below the stop threshold', () => {
    // Default stopAfterSeconds is 3 days; archiving after 1s must fail.
    expect(() =>
      resolvePolicy({ archiveAfterSeconds: 1 }, ARCHIVE_DEFAULT_SECONDS),
    ).toThrow(/stopAfterSeconds/);
  });

  it('rejects archiving a sandbox that never stops', () => {
    expect(() =>
      resolvePolicy(
        { stopAfterSeconds: null, archiveAfterSeconds: 60 },
        ARCHIVE_DEFAULT_SECONDS,
      ),
    ).toThrow(/archiveAfterSeconds requires a stopAfterSeconds/);
  });
});
