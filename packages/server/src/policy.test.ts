import { DEFAULT_LIFECYCLE_POLICY } from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { ARCHIVE_DEFAULT_SECONDS, resolvePolicy } from './policy';

// The two default shapes a real boot seeds into the ledger: without an
// archiver the archive knob is null, with one it is the 7-day seed.
const NO_ARCHIVER_DEFAULTS = DEFAULT_LIFECYCLE_POLICY;
const ARCHIVER_DEFAULTS = {
  ...DEFAULT_LIFECYCLE_POLICY,
  archiveAfterSeconds: ARCHIVE_DEFAULT_SECONDS,
};

describe('resolvePolicy without an archiver (archiveEnabled = false)', () => {
  it('returns the defaults when no override is given', () => {
    expect(resolvePolicy(undefined, NO_ARCHIVER_DEFAULTS, false)).toEqual(
      DEFAULT_LIFECYCLE_POLICY,
    );
    expect(resolvePolicy({}, NO_ARCHIVER_DEFAULTS, false)).toEqual(
      DEFAULT_LIFECYCLE_POLICY,
    );
  });

  it('merges a partial override over the defaults', () => {
    expect(
      resolvePolicy({ freezeAfterSeconds: 60 }, NO_ARCHIVER_DEFAULTS, false),
    ).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      freezeAfterSeconds: 60,
    });
  });

  it('keeps an explicit null for archiveAfterSeconds (never archive)', () => {
    expect(
      resolvePolicy({ archiveAfterSeconds: null }, NO_ARCHIVER_DEFAULTS, false)
        .archiveAfterSeconds,
    ).toBeNull();
  });

  it('refuses an explicit archive threshold — no archiver, no promise', () => {
    expect(() =>
      resolvePolicy({ archiveAfterSeconds: 60 }, NO_ARCHIVER_DEFAULTS, false),
    ).toThrow(/archiving requires S3 \(DORMICE_S3_\*\) to be configured/);
  });

  it('rejects a merged result that violates freeze <= stop', () => {
    expect(() =>
      resolvePolicy(
        { freezeAfterSeconds: 61, stopAfterSeconds: 60 },
        NO_ARCHIVER_DEFAULTS,
        false,
      ),
    ).toThrow(/freezeAfterSeconds/);
  });

  it('keeps an explicit null for stopAfterSeconds (never stop)', () => {
    // The resident-agent policy: park frozen forever, wake in ~50ms, never
    // decay to a cold boot.
    expect(
      resolvePolicy({ stopAfterSeconds: null }, NO_ARCHIVER_DEFAULTS, false)
        .stopAfterSeconds,
    ).toBeNull();
  });
});

describe('resolvePolicy with an archiver (archiveEnabled = true)', () => {
  it('defaults new sandboxes to archiving after the seeded week', () => {
    expect(resolvePolicy(undefined, ARCHIVER_DEFAULTS, true)).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      archiveAfterSeconds: ARCHIVE_DEFAULT_SECONDS,
    });
  });

  it('keeps an explicit null for archiveAfterSeconds (never archive)', () => {
    expect(
      resolvePolicy({ archiveAfterSeconds: null }, ARCHIVER_DEFAULTS, true)
        .archiveAfterSeconds,
    ).toBeNull();
  });

  it('never archives a never-stop sandbox — the default yields to the override', () => {
    // Only a stopped sandbox can archive; a stop:null override with the
    // 7-day default left in place would be an invalid policy, so the
    // default steps aside instead of turning the override into a 400.
    expect(
      resolvePolicy({ stopAfterSeconds: null }, ARCHIVER_DEFAULTS, true),
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
      resolvePolicy({ stopAfterSeconds: thirtyDays }, ARCHIVER_DEFAULTS, true),
    ).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      stopAfterSeconds: thirtyDays,
      archiveAfterSeconds: thirtyDays,
    });
  });

  it('rejects an explicit archive threshold below the stop threshold', () => {
    // Default stopAfterSeconds is 3 days; archiving after 1s must fail.
    expect(() =>
      resolvePolicy({ archiveAfterSeconds: 1 }, ARCHIVER_DEFAULTS, true),
    ).toThrow(/stopAfterSeconds/);
  });

  it('rejects archiving a sandbox that never stops', () => {
    expect(() =>
      resolvePolicy(
        { stopAfterSeconds: null, archiveAfterSeconds: 60 },
        ARCHIVER_DEFAULTS,
        true,
      ),
    ).toThrow(/archiveAfterSeconds requires a stopAfterSeconds/);
  });
});

describe('resolvePolicy with operator-edited defaults (runtime settings)', () => {
  it('an operator default of never-stop flows to new sandboxes', () => {
    expect(
      resolvePolicy(
        undefined,
        {
          freezeAfterSeconds: 120,
          stopAfterSeconds: null,
          archiveAfterSeconds: null,
        },
        true,
      ),
    ).toEqual({
      freezeAfterSeconds: 120,
      stopAfterSeconds: null,
      archiveAfterSeconds: null,
    });
  });

  it('a never-archive default still accepts an explicit archive override', () => {
    // The archiver exists; the operator merely changed what "asks for
    // nothing" means. An explicit request must not be refused.
    const week = 7 * 24 * 60 * 60;
    expect(
      resolvePolicy(
        { archiveAfterSeconds: week },
        { ...DEFAULT_LIFECYCLE_POLICY, archiveAfterSeconds: null },
        true,
      ).archiveAfterSeconds,
    ).toBe(week);
  });
});
