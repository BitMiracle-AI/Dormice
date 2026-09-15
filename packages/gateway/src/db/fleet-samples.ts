import { and, asc, desc, gte, lt, lte } from 'drizzle-orm';
import { type Fleet, sumReadings } from '../fleet';
import type { Db } from './db';
import { type FleetStateSampleRow, fleetStateSamples } from './schema';

/**
 * How long fleet state samples live. Not a knob: the dashboard's widest
 * range (30 days) defines the need, and at one small row per tick the
 * table stays a few megabytes whatever the fleet's size (the node's old
 * fleet table had the same ruling).
 */
export const FLEET_SAMPLE_KEEP_DAYS = 30;

/**
 * One sample of the fleet's state, written by the gateway's own ticker
 * (main.ts, every DORMICE_GATEWAY_SAMPLE_INTERVAL_SECONDS): the sum over
 * every node that has a reading — a node that is down contributes its
 * last one; its sandboxes are still there. Prune rides the same
 * transaction, as on the node's sampler. A tick of the gateway's, not the
 * check-in itself (the third cut first wrote a row per check-in; its
 * review moved it, 2026-09-15): one figure, one row an interval, however
 * many nodes report it — and a write that fails, a full disk, fails a
 * sample the next tick retries, never a node's check-in and the
 * configuration bundle riding on its answer.
 *
 * Not written when there is nothing true to write: no node has a reading
 * — an empty fleet, or rows that never checked in (the import's) — the
 * fleet's sandboxes are on the nodes' disks, unknown here, and a zero
 * row would draw a cliff the fleet did not fall off. A restart draws no
 * false dip either: every node's last reading comes back from its row
 * (fleet.ts), so the first tick after a restart sums the whole fleet as
 * of before it. The third cut, with the readings in memory only, held
 * the write for a startup grace while any known node had not checked in
 * — a sum written after the first would have drawn the fleet collapsing
 * to that node's share and climbing back; the rows made the rule
 * unnecessary (fourth cut). Answers whether a row was written.
 */
export function recordFleetSample(db: Db, fleet: Fleet, now: Date): boolean {
  const { reported, sandboxes } = sumReadings(fleet.all());
  if (reported === 0) return false;
  const cutoff = new Date(
    now.getTime() - FLEET_SAMPLE_KEEP_DAYS * 86_400_000,
  ).toISOString();
  db.transaction((tx) => {
    tx.insert(fleetStateSamples)
      .values({
        at: now.toISOString(),
        ...sandboxes.byState,
        total: sandboxes.total,
      })
      .run();
    tx.delete(fleetStateSamples).where(lt(fleetStateSamples.at, cutoff)).run();
  });
  return true;
}

/** Ascending slice — ISO strings compare lexicographically as time. */
export function queryFleetSamples(
  db: Db,
  startIso: string,
  endIso: string,
): FleetStateSampleRow[] {
  return db
    .select()
    .from(fleetStateSamples)
    .where(
      and(
        gte(fleetStateSamples.at, startIso),
        lte(fleetStateSamples.at, endIso),
      ),
    )
    .orderBy(asc(fleetStateSamples.at))
    .all();
}

/**
 * The window's concurrency peak, from raw rows so no bucketing can flatten
 * it: highest active count, and the earliest instant it was observed.
 */
export function queryFleetPeak(
  db: Db,
  startIso: string,
  endIso: string,
): { active: number; at: string } | null {
  const row = db
    .select({ active: fleetStateSamples.active, at: fleetStateSamples.at })
    .from(fleetStateSamples)
    .where(
      and(
        gte(fleetStateSamples.at, startIso),
        lte(fleetStateSamples.at, endIso),
      ),
    )
    .orderBy(desc(fleetStateSamples.active), asc(fleetStateSamples.at))
    .limit(1)
    .get();
  return row ?? null;
}
