import { and, asc, desc, gte, lt, lte } from 'drizzle-orm';
import { type Fleet, STARTUP_GRACE_MS, sumReadings } from '../fleet';
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
 * (nothing has checked in since this start — the fleet's sandboxes are
 * on the nodes' disks, unknown here, and a zero row would draw a cliff
 * the fleet did not fall off); or, within STARTUP_GRACE_MS of a start,
 * while any node from the rows has not checked in yet — a restarted
 * gateway hears from its nodes one by one over an interval, and a sum
 * written after the first would draw the fleet collapsing to that node's
 * share and climbing back, a false dip at every gateway restart. Past the
 * grace, a node still silent is down, and the sum is written without it
 * (a lower bound, as getFleetMetrics says of the same figure). Answers
 * whether a row was written.
 */
export function recordFleetSample(db: Db, fleet: Fleet, now: Date): boolean {
  const nodes = fleet.all();
  const { reported, sandboxes } = sumReadings(nodes);
  const settling = now.getTime() - fleet.startedAt.getTime() < STARTUP_GRACE_MS;
  if (reported === 0 || (settling && reported < nodes.length)) return false;
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
