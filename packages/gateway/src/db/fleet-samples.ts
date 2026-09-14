import { and, asc, desc, gte, lt, lte } from 'drizzle-orm';
import { type Fleet, STARTUP_GRACE_MS, sumReadings } from '../fleet';
import type { Db } from './db';
import { type FleetStateSampleRow, fleetStateSamples } from './schema';

/**
 * How long fleet state samples live. Not a knob: the dashboard's widest
 * range (30 days) defines the need, and at one small row per check-in the
 * table stays tens of megabytes for a fleet of ten (the node's old fleet
 * table had the same ruling).
 */
export const FLEET_SAMPLE_KEEP_DAYS = 30;

/**
 * One sample of the fleet's state, written on a check-in (routes/nodes.ts)
 * once the reporting node's reading is in: the sum over every node that
 * has a reading — a node that is down contributes its last one; its
 * sandboxes are still there. Prune rides the same transaction, as on the
 * node's sampler.
 *
 * Not written while the gateway is still getting to know its fleet:
 * within STARTUP_GRACE_MS of a start, as long as any node from the rows
 * has not checked in yet. A restarted gateway hears from its nodes one by
 * one over an interval, and a sum written after the first would draw the
 * fleet collapsing to that node's share and climbing back — a false dip
 * on the curve at every gateway restart. Past the grace, a node still
 * silent is down, and the sum is written without it (a lower bound, as
 * getFleetMetrics says of the same figure). Answers whether a row was
 * written.
 */
export function recordFleetSample(db: Db, fleet: Fleet, now: Date): boolean {
  const nodes = fleet.all();
  const settling = now.getTime() - fleet.startedAt.getTime() < STARTUP_GRACE_MS;
  if (settling && nodes.some((node) => node.reading === null)) return false;
  const { sandboxes } = sumReadings(nodes);
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
