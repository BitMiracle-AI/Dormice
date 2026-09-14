import {
  getFleetMetricsResponseSchema,
  getFleetStateHistoryResponseSchema,
} from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { recordFleetSample } from '../db/fleet-samples';
import { fleetStateSamples } from '../db/schema';
import { STARTUP_GRACE_MS } from '../fleet';
import { checkInOf, TEST_TOKEN, testGateway } from '../testing';

// The fleet's own observation: what the sampler writes (recordFleetSample
// is the ticker's unit; main.ts owns the clock), what the two verbs read
// back — over app.inject(), the check-ins posted as a node posts them.

const authed = { authorization: `Bearer ${TEST_TOKEN}` };
type App = ReturnType<typeof testGateway>['app'];

function rpc(app: App, url: string, payload: object = {}) {
  return app.inject({ method: 'POST', url, headers: authed, payload });
}

async function checkIn(
  app: App,
  id: string,
  over: Parameters<typeof checkInOf>[2] = {},
) {
  const res = await rpc(
    app,
    '/checkIn',
    checkInOf(id, `http://${id}:80`, over),
  );
  expect(res.statusCode).toBe(200);
}

/** A gateway started long enough ago that no startup grace applies — against the real clock, which the check-in route reads. */
const SETTLED = new Date(Date.now() - STARTUP_GRACE_MS - 60_000);

function samples(db: ReturnType<typeof testGateway>['db']) {
  return db
    .select()
    .from(fleetStateSamples)
    .orderBy(fleetStateSamples.at)
    .all();
}

describe('the fleet state sample the sampler writes', () => {
  it('a tick writes one row: the sum over every node with a reading, a down node counted by its last reading — and a check-in writes none', async () => {
    const { app, db, fleet } = testGateway({}, { startedAt: SETTLED });
    await checkIn(app, 'b', { active: 3, frozen: 1 });
    await checkIn(app, 'c', { active: 2, archived: 4 });
    // The check-ins themselves wrote nothing: the sampler's clock is the
    // gateway's own, and no check-in waits on a history write.
    expect(samples(db)).toHaveLength(0);
    expect(recordFleetSample(db, fleet, new Date())).toBe(true);
    expect(samples(db)).toEqual([
      expect.objectContaining({
        active: 5,
        frozen: 1,
        archived: 4,
        total: 10,
      }),
    ]);
    // c falls silent: its sandboxes are still there, and its last reading
    // stays in the sum.
    const c = fleet.get('c');
    if (!c) throw new Error('node lost');
    c.lastCheckInAt = new Date(Date.now() - 40_000);
    recordFleetSample(db, fleet, new Date());
    expect(samples(db)[1]).toMatchObject({ active: 5, total: 10 });
    // Removed, it is counted no more.
    expect((await rpc(app, '/removeNode', { id: 'c' })).json()).toEqual({
      removed: true,
    });
    recordFleetSample(db, fleet, new Date());
    expect(samples(db)[2]).toMatchObject({ active: 3, total: 4 });
  });

  it('no row while no node has a reading; within the startup grace none while a known node has not checked in; past it the sum is written without it', () => {
    // A node known from the rows but not heard from since this start: a
    // check-in's reading, then the memory a restart leaves — the row and
    // nothing else (fleet.ts's constructor shape).
    const silence = (fleet: ReturnType<typeof testGateway>['fleet']) => {
      fleet.checkIn(checkInOf('c', 'http://c:80', { active: 1 }));
      const c = fleet.get('c');
      if (!c) throw new Error('node lost');
      c.reading = null;
      c.lastCheckInAt = null;
      c.intervalSeconds = null;
    };
    // Nobody has reported: nothing true to write, however long ago the
    // gateway started — and an empty fleet writes nothing either.
    const unheard = testGateway({}, { startedAt: SETTLED });
    expect(recordFleetSample(unheard.db, unheard.fleet, new Date())).toBe(
      false,
    );
    silence(unheard.fleet);
    expect(recordFleetSample(unheard.db, unheard.fleet, new Date())).toBe(
      false,
    );
    expect(samples(unheard.db)).toHaveLength(0);

    const fresh = testGateway({}, { startedAt: new Date() });
    silence(fresh.fleet);
    fresh.fleet.checkIn(checkInOf('b', 'http://b:80', { active: 2 }));
    expect(recordFleetSample(fresh.db, fresh.fleet, new Date())).toBe(false);
    expect(samples(fresh.db)).toHaveLength(0);

    const settled = testGateway({}, { startedAt: SETTLED });
    silence(settled.fleet);
    settled.fleet.checkIn(checkInOf('b', 'http://b:80', { active: 2 }));
    expect(recordFleetSample(settled.db, settled.fleet, new Date())).toBe(true);
    expect(samples(settled.db)).toEqual([
      expect.objectContaining({ active: 2, total: 2 }),
    ]);
  });

  it('rows older than 30 days are pruned with the write', () => {
    const { db, fleet } = testGateway({}, { startedAt: SETTLED });
    db.insert(fleetStateSamples)
      .values({
        at: new Date(Date.now() - 31 * 86_400_000).toISOString(),
        active: 9,
        frozen: 0,
        stopped: 0,
        archived: 0,
        restoring: 0,
        total: 9,
      })
      .run();
    fleet.checkIn(checkInOf('b', 'http://b:80', { active: 1 }));
    recordFleetSample(db, fleet, new Date());
    const rows = samples(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.active).toBe(1);
  });
});

describe('getFleetMetrics', () => {
  it('sums the census and the disks over the reported nodes, and says how many nodes that is', async () => {
    const { app, fleet } = testGateway({}, { startedAt: SETTLED });
    await checkIn(app, 'b', { active: 3, frozen: 1 });
    await checkIn(app, 'c', { active: 2, archived: 4 });
    // A third node known from a previous run, not heard from: in total,
    // not in reported, not in the sums.
    fleet.checkIn(checkInOf('d', 'http://d:80'));
    const d = fleet.get('d');
    if (!d) throw new Error('node lost');
    d.reading = null;
    d.lastCheckInAt = null;
    d.intervalSeconds = null;
    const res = await rpc(app, '/getFleetMetrics');
    expect(res.statusCode).toBe(200);
    const body = getFleetMetricsResponseSchema.parse(res.json());
    expect(body.nodes).toEqual({ total: 3, reachable: 2, reported: 2 });
    expect(body.sandboxes).toEqual({
      total: 10,
      byState: { active: 5, frozen: 1, stopped: 0, archived: 4, restoring: 0 },
    });
    // The scaffolding's reading carries no disks (a node on the previous
    // build): the bill is an honest zero, not a refusal.
    expect(body.sandboxDisks).toEqual({
      count: 0,
      nominalBytes: 0,
      actualBytes: 0,
    });
  });

  it('sums the disks a reading carries', async () => {
    const { app } = testGateway({}, { startedAt: SETTLED });
    const withDisks = (id: string, count: number) => ({
      ...checkInOf(id, `http://${id}:80`),
      reading: {
        ...checkInOf(id, `http://${id}:80`).reading,
        sandboxDisks: { count, nominalBytes: count * 10, actualBytes: count },
      },
    });
    expect((await rpc(app, '/checkIn', withDisks('b', 2))).statusCode).toBe(
      200,
    );
    expect((await rpc(app, '/checkIn', withDisks('c', 3))).statusCode).toBe(
      200,
    );
    const body = getFleetMetricsResponseSchema.parse(
      (await rpc(app, '/getFleetMetrics')).json(),
    );
    expect(body.sandboxDisks).toEqual({
      count: 5,
      nominalBytes: 50,
      actualBytes: 5,
    });
  });

  it('is behind the sandbox gate: a minted key reads it, no token does not', async () => {
    const { app } = testGateway({}, { startedAt: SETTLED });
    const minted = (await rpc(app, '/createApiKey', { name: 'ci' })).json();
    const keyed = await app.inject({
      method: 'POST',
      url: '/getFleetMetrics',
      headers: { authorization: `Bearer ${minted.token}` },
      payload: {},
    });
    expect(keyed.statusCode).toBe(200);
    const bare = await app.inject({
      method: 'POST',
      url: '/getFleetMetrics',
      payload: {},
    });
    expect(bare.statusCode).toBe(401);
  });
});

describe('getFleetStateHistory', () => {
  it('answers an empty window with no points and a null peak; then the samples ascending, byState summing to total, the peak from raw rows', async () => {
    const { app, db } = testGateway({}, { startedAt: SETTLED });
    const empty = getFleetStateHistoryResponseSchema.parse(
      (await rpc(app, '/getFleetStateHistory', {})).json(),
    );
    expect(empty).toEqual({ points: [], bucketSeconds: null, peak: null });

    const t0 = Date.parse('2026-09-15T10:00:00.000Z');
    const row = (offsetMs: number, active: number) => ({
      at: new Date(t0 + offsetMs).toISOString(),
      active,
      frozen: 1,
      stopped: 0,
      archived: 0,
      restoring: 0,
      total: active + 1,
    });
    db.insert(fleetStateSamples)
      .values([row(0, 2), row(15_000, 7), row(30_000, 3)])
      .run();
    const body = getFleetStateHistoryResponseSchema.parse(
      (
        await rpc(app, '/getFleetStateHistory', {
          start: new Date(t0 - 1000).toISOString(),
          end: new Date(t0 + 60_000).toISOString(),
        })
      ).json(),
    );
    expect(body.bucketSeconds).toBeNull();
    expect(body.points.map((p) => p.byState.active)).toEqual([2, 7, 3]);
    for (const point of body.points) {
      const sum = Object.values(point.byState).reduce((a, b) => a + b, 0);
      expect(sum).toBe(point.total);
    }
    expect(body.peak).toEqual({
      active: 7,
      at: new Date(t0 + 15_000).toISOString(),
    });
  });

  it("buckets past 360 points by keeping each bucket's last whole row, and the peak survives bucketing", async () => {
    const { app, db } = testGateway({}, { startedAt: SETTLED });
    const t0 = Date.parse('2026-09-15T00:00:00.000Z');
    const rows = 400;
    const values = [];
    for (let i = 0; i < rows; i += 1) {
      values.push({
        at: new Date(t0 + i * 15_000).toISOString(),
        active: 1,
        frozen: 0,
        stopped: 0,
        archived: 0,
        restoring: 0,
        total: 1,
      });
    }
    // A spike squeezed between two grid rows of its own bucket.
    values.push({
      at: new Date(t0 + 200 * 15_000 + 500).toISOString(),
      active: 9,
      frozen: 0,
      stopped: 0,
      archived: 0,
      restoring: 0,
      total: 9,
    });
    db.insert(fleetStateSamples).values(values).run();
    const body = getFleetStateHistoryResponseSchema.parse(
      (
        await rpc(app, '/getFleetStateHistory', {
          start: new Date(t0).toISOString(),
          end: new Date(t0 + rows * 15_000).toISOString(),
        })
      ).json(),
    );
    expect(body.bucketSeconds).not.toBeNull();
    expect(body.points.length).toBeLessThanOrEqual(360);
    expect(body.peak).toEqual({
      active: 9,
      at: new Date(t0 + 200 * 15_000 + 500).toISOString(),
    });
    for (const point of body.points) {
      const sum = Object.values(point.byState).reduce((a, b) => a + b, 0);
      expect(sum).toBe(point.total);
    }
  });

  it('rejects an unparseable timestamp at the door', async () => {
    const { app } = testGateway();
    const res = await rpc(app, '/getFleetStateHistory', { start: 'yesterday' });
    expect(res.statusCode).toBe(400);
  });
});
