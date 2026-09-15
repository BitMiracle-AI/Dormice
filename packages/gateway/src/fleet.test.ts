import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrateDb, openDb } from './db/db';
import { nodes } from './db/schema';
import { type CheckInOutcome, downReason, Fleet, type FleetLog } from './fleet';
import { checkInOf } from './testing';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const NOW = new Date('2026-09-14T12:00:00.000Z');

/** A check-in the test expects to be taken. */
function taken(outcome: CheckInOutcome) {
  if ('refused' in outcome) throw new Error(outcome.refused);
  return outcome;
}

function db() {
  const handle = openDb(':memory:');
  migrateDb(handle, MIGRATIONS);
  return handle;
}

/** A log that keeps what the fleet said, level and structured part included. */
function collector() {
  const lines: Array<{
    level: string;
    obj: Record<string, unknown>;
    msg: string;
  }> = [];
  const line = (level: string) => (obj: object, msg: string) =>
    lines.push({ level, obj: obj as Record<string, unknown>, msg });
  const log: FleetLog = {
    info: line('info'),
    warn: line('warn'),
    error: line('error'),
  };
  return { lines, log };
}

describe('Fleet', () => {
  it('a first check-in joins the node and persists what it said; a gateway restart reads the node back as of that check-in and judges it by it', () => {
    const handle = db();
    const fleet = new Fleet(handle);
    expect(fleet.all()).toEqual([]);
    const { node, joined } = taken(
      fleet.checkIn(
        checkInOf('node-b', 'http://10.0.0.7:80', {
          intervalSeconds: 15,
          active: 4,
        }),
        NOW,
      ),
    );
    expect(joined).toBe(true);
    expect(node.addedAt).toBe(NOW.toISOString());
    expect(node.lastCheckInAt).toBe(NOW);
    expect(node.reading?.host.cpuCount).toBe(8);
    expect(downReason(node, NOW)).toBeNull();

    // The same database after a restart: the row carries the check-in,
    // and the node is judged by it — up a moment on, down two of its
    // intervals on — never by how long this gateway has been running.
    const restarted = new Fleet(handle);
    const known = restarted.get('node-b');
    if (!known) throw new Error('row lost');
    expect(known).toMatchObject({
      endpoint: 'http://10.0.0.7:80',
      addedAt: NOW.toISOString(),
      lastCheckInAt: NOW,
      intervalSeconds: 15,
      configVersion: 1,
      build: {
        commit: 'abc1234',
        title: 'a commit',
        committedAt: '2026-09-14T00:00:00.000Z',
      },
      placedSinceCheckIn: 0,
    });
    expect(known.reading).toEqual(node.reading);
    expect(downReason(known, new Date(NOW.getTime() + 29_000))).toBeNull();
    expect(downReason(known, new Date(NOW.getTime() + 31_000))).toBe(
      'has not checked in for 31s',
    );
  });

  it('a row that never checked in (the import pre-creates one) is known and down, with the word for it; a row whose JSON no longer reads is loaded without it, said once, and filled in by the next check-in', () => {
    const handle = db();
    handle
      .insert(nodes)
      .values({
        id: 'node-1',
        endpoint: 'http://127.0.0.1:3676',
        addedAt: NOW.toISOString(),
        swapGb: 8,
      })
      .run();
    handle
      .insert(nodes)
      .values({
        id: 'node-x',
        endpoint: 'http://x:80',
        addedAt: NOW.toISOString(),
        lastCheckInAt: NOW.toISOString(),
        intervalSeconds: 15,
        configVersion: 1,
        build: '{"commit":',
        reading: JSON.stringify({ host: 'not a reading' }),
      })
      .run();
    const { lines, log } = collector();
    const fleet = new Fleet(handle, log);
    const fresh = fleet.get('node-1');
    if (!fresh) throw new Error('row lost');
    expect(fresh).toMatchObject({
      swapGb: 8,
      lastCheckInAt: null,
      intervalSeconds: null,
      configVersion: null,
      build: null,
      reading: null,
    });
    expect(downReason(fresh, NOW)).toBe('has never checked in');
    expect(fleet.get('node-x')).toMatchObject({
      lastCheckInAt: NOW,
      intervalSeconds: 15,
      build: null,
      reading: null,
    });
    expect(lines.map((l) => [l.level, l.obj.nodeId, l.obj.column])).toEqual([
      ['warn', 'node-x', 'build'],
      ['warn', 'node-x', 'reading'],
    ]);
    taken(fleet.checkIn(checkInOf('node-x', 'http://x:80'), NOW));
    expect(new Fleet(handle).get('node-x')?.reading?.host.cpuCount).toBe(8);
  });

  it('a check-in whose row cannot be written is taken all the same — memory updated, one error line until the writes succeed again; a join must land', () => {
    const handle = db();
    const { lines, log } = collector();
    const fleet = new Fleet(handle, log);
    const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
    const report = (active: number, when: Date) =>
      taken(
        fleet.checkIn(
          checkInOf('node-b', 'http://10.0.0.7:80', { active }),
          when,
        ),
      ).node;
    report(1, NOW);
    // Every write refused from here — a full disk's shape.
    handle.$client.pragma('query_only = 1');
    const node = report(2, at(15));
    expect(node.lastCheckInAt).toEqual(at(15));
    expect(node.reading?.sandboxes.byState.active).toBe(2);
    report(3, at(30));
    expect(lines.map((l) => [l.level, l.obj.nodeId])).toEqual([
      ['error', 'node-b'],
    ]);
    // The row still says the last check-in that was written.
    expect(
      new Fleet(handle).get('node-b')?.reading?.sandboxes.byState.active,
    ).toBe(1);
    handle.$client.pragma('query_only = 0');
    report(4, at(45));
    expect(lines.map((l) => l.level)).toEqual(['error', 'info']);
    expect(
      new Fleet(handle).get('node-b')?.reading?.sandboxes.byState.active,
    ).toBe(4);
    // A join, by contrast, throws: a node no row holds is unknown to the
    // next gateway process.
    handle.$client.pragma('query_only = 1');
    expect(() =>
      fleet.checkIn(checkInOf('node-c', 'http://c:80'), NOW),
    ).toThrow();
    expect(fleet.get('node-c')).toBeUndefined();
  });

  it('a later check-in is not a join; a changed endpoint inside the interval is refused as a second daemon, an interval later written through as a move; the placement counter restarts', () => {
    const handle = db();
    const fleet = new Fleet(handle);
    const first = taken(
      fleet.checkIn(checkInOf('node-b', 'http://10.0.0.7:80'), NOW),
    );
    first.node.placedSinceCheckIn = 3;
    const twin = fleet.checkIn(
      checkInOf('node-b', 'http://10.0.0.8:80'),
      new Date(NOW.getTime() + 7_000),
    );
    expect('refused' in twin && twin.refused).toMatch(
      /^node node-b checked in from http:\/\/10\.0\.0\.7:80 7s ago and now from http:\/\/10\.0\.0\.8:80 — two daemons share one DORMICE_NODE_ID/,
    );
    expect(first.node.endpoint).toBe('http://10.0.0.7:80');
    expect(first.node.placedSinceCheckIn).toBe(3);
    const second = taken(
      fleet.checkIn(
        checkInOf('node-b', 'http://10.0.0.8:80', { active: 12 }),
        new Date(NOW.getTime() + 15_000),
      ),
    );
    expect(second.joined).toBe(false);
    expect(first.movedFrom).toBeNull();
    expect(second.movedFrom).toBe('http://10.0.0.7:80');
    expect(second.node).toBe(first.node);
    expect(second.node.endpoint).toBe('http://10.0.0.8:80');
    expect(second.node.reading?.sandboxes.byState.active).toBe(12);
    expect(second.node.placedSinceCheckIn).toBe(0);
    expect(new Fleet(handle).get('node-b')?.endpoint).toBe(
      'http://10.0.0.8:80',
    );
  });

  it('downReason: fresh within two of its own intervals, down past them', () => {
    const fleet = new Fleet(db());
    const { node } = taken(
      fleet.checkIn(
        checkInOf('node-b', 'http://10.0.0.7:80', { intervalSeconds: 15 }),
        NOW,
      ),
    );
    expect(downReason(node, new Date(NOW.getTime() + 29_000))).toBeNull();
    expect(downReason(node, new Date(NOW.getTime() + 31_000))).toBe(
      'has not checked in for 31s',
    );
    // A one-second node (the exam's) is judged by its own interval.
    const quick = taken(
      fleet.checkIn(
        checkInOf('node-c', 'http://10.0.0.9:80', { intervalSeconds: 1 }),
        NOW,
      ),
    ).node;
    expect(downReason(quick, new Date(NOW.getTime() + 1_500))).toBeNull();
    expect(downReason(quick, new Date(NOW.getTime() + 2_500))).toBe(
      'has not checked in for 3s',
    );
  });

  it('remove forgets the node and its row; removing an unknown id is false; a node that checks in again re-joins', () => {
    const handle = db();
    const fleet = new Fleet(handle);
    fleet.checkIn(checkInOf('node-b', 'http://10.0.0.7:80'), NOW);
    expect(fleet.remove('node-b')).toBe(true);
    expect(fleet.all()).toEqual([]);
    expect(new Fleet(handle).all()).toEqual([]);
    expect(fleet.remove('node-b')).toBe(false);
    expect(
      taken(fleet.checkIn(checkInOf('node-b', 'http://10.0.0.7:80'), NOW))
        .joined,
    ).toBe(true);
  });
});
