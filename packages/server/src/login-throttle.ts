/**
 * Failure backoff for the console's credential endpoints. Passwords are
 * human-chosen (low entropy, unlike the 128-bit API token), so online
 * guessing became a real surface the moment they arrived — this is the
 * counterpart the password design must ship with.
 *
 * In-memory on purpose: crash-only means a restart honestly forgets the
 * counters, and persisting attacker state in the ledger would be a second
 * database to babysit for no real gain. Keyed by client IP; behind the
 * usual single reverse proxy every client shares 127.0.0.1, collapsing this
 * into a global throttle — acceptable and arguably right for a single
 * account (it is the account being guessed at, not the caller).
 */

/** Free attempts before delays start: typos are not attacks. */
const FREE_FAILURES = 5;
/** Delay doubles per failure past the free ones, capped here. */
const MAX_DELAY_SECONDS = 300;
/** Counters idle this long are forgotten (also the sweep horizon). */
const FORGET_AFTER_MS = 60 * 60 * 1000;

interface Entry {
  failures: number;
  /** Epoch ms before which further attempts are refused. */
  blockedUntil: number;
  lastFailureAt: number;
}

export class LoginThrottle {
  private entries = new Map<string, Entry>();

  /** Seconds the caller must still wait, or 0 when an attempt is allowed. */
  retryAfterSeconds(key: string, nowMs = Date.now()): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    if (nowMs - entry.lastFailureAt > FORGET_AFTER_MS) {
      this.entries.delete(key);
      return 0;
    }
    return Math.max(0, Math.ceil((entry.blockedUntil - nowMs) / 1000));
  }

  recordFailure(key: string, nowMs = Date.now()): void {
    this.sweep(nowMs);
    const entry = this.entries.get(key) ?? {
      failures: 0,
      blockedUntil: 0,
      lastFailureAt: 0,
    };
    entry.failures += 1;
    entry.lastFailureAt = nowMs;
    const past = entry.failures - FREE_FAILURES;
    if (past > 0) {
      const delay = Math.min(2 ** (past - 1), MAX_DELAY_SECONDS);
      entry.blockedUntil = nowMs + delay * 1000;
    }
    this.entries.set(key, entry);
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Drops idle counters on the write path — no timer to manage, and the map
   * stays bounded by "distinct keys failing within the last hour", which a
   * loopback-bound daemon can always afford.
   */
  private sweep(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.lastFailureAt > FORGET_AFTER_MS) {
        this.entries.delete(key);
      }
    }
  }
}
