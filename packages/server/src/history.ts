/**
 * The pure half of a history verb — how a window's defaults resolve, when
 * an answer is bucketed and how wide, and the one bucketing that keeps
 * whole rows. Shared by the daemon's own history verbs
 * (getSandboxMetricsHistory, getHostMetricsHistory, the E2B metrics slice)
 * and by the gateway's getFleetStateHistory over its fleet_state_samples,
 * through the `@dormice/server/history` subpath: the gateway reuses the
 * rulings without loading the daemon's executor, the way it reuses the
 * lock and the queue. Nothing here touches a database.
 */

/**
 * The most points a history answer carries. One ceiling for every consumer
 * (native verbs, the E2B slice, the gateway's fleet history): past it the
 * server buckets, so a 30-day window costs ~360 points on the wire instead
 * of 86k raw rows no chart could draw anyway.
 */
export const MAX_POINTS = 360;

/**
 * Resolves a history verb's optional ISO window: end defaults to now, start
 * to end minus the verb's default span. One resolver for every verb so
 * "defaults" cannot drift apart. Parseability is the request schema's job
 * (a malformed timestamp is rejected as a 400 at the door, never NaN here).
 */
export function resolveWindow(
  start: string | undefined,
  end: string | undefined,
  defaultSpanMs: number,
  now: Date,
): { startIso: string; endIso: string; startMs: number; endMs: number } {
  const endMs = end !== undefined ? Date.parse(end) : now.getTime();
  const startMs =
    start !== undefined ? Date.parse(start) : endMs - defaultSpanMs;
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    startMs,
    endMs,
  };
}

/**
 * Decides the answer's granularity: raw under MAX_POINTS, bucketed past it.
 * The server picks — one ruling for every caller, clients never negotiate.
 */
export function resolveBucketSeconds(
  rawCount: number,
  startMs: number,
  endMs: number,
): number | null {
  if (rawCount <= MAX_POINTS) return null;
  return Math.max(1, Math.ceil((endMs - startMs) / 1000 / MAX_POINTS));
}

/** Which bucket a row falls in, counted from the window's start. */
export function bucketIndex(
  atIso: string,
  startMs: number,
  bucketSeconds: number,
): number {
  return Math.floor((Date.parse(atIso) - startMs) / (bucketSeconds * 1000));
}

/**
 * Buckets rows by keeping each bucket's LAST raw row whole — for a row
 * whose fields are one consistent observation (a census by state: never
 * per-state maxima, which would count a sandbox mid-transition twice and
 * break byState summing to total). Every emitted point really happened;
 * a window's peak travels separately, computed from the raw rows. Rows
 * arrive ascending, so a later row simply overwrites the bucket.
 */
export function bucketLast<T extends { at: string }>(
  rows: T[],
  startMs: number,
  bucketSeconds: number,
): T[] {
  const buckets = new Map<number, T>();
  for (const row of rows) {
    buckets.set(bucketIndex(row.at, startMs, bucketSeconds), row);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}
