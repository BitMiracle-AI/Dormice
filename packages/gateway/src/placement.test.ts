import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Db, migrateDb, openDb } from './db/db';
import { nodes } from './db/schema';
import { Fleet, type NodeState } from './fleet';
import { type PlacementKnobs, pick, refusalMessage } from './placement';
import { checkInOf, type reading } from './testing';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const NOW = new Date('2026-09-14T12:00:00.000Z');
const KNOBS: PlacementKnobs = {
  cpuLimitPct: 70,
  activeLimit: 400,
  minDiskAvailableBytes: 10 * 2 ** 30,
};

function fleet(): { db: Db; fleet: Fleet } {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  return { db, fleet: new Fleet(db) };
}

/** A node that checked in at NOW (or when told) with the given reading. */
function node(
  f: Fleet,
  id: string,
  over: Parameters<typeof reading>[0] & {
    intervalSeconds?: number;
    placed?: number;
    checkedInAt?: Date;
  } = {},
): NodeState {
  const outcome = f.checkIn(
    checkInOf(id, `http://${id}:80`, over),
    over.checkedInAt ?? NOW,
  );
  if ('refused' in outcome) throw new Error(outcome.refused);
  const { node } = outcome;
  node.placedSinceCheckIn = over.placed ?? 0;
  return node;
}

describe('pick', () => {
  it('cpu above the limit refuses, at the limit passes, unknown passes', () => {
    const f = fleet().fleet;
    expect(pick([node(f, 'a', { cpu: 71 })], KNOBS, NOW).node).toBeNull();
    expect(pick([node(f, 'b', { cpu: 70 })], KNOBS, NOW).node?.id).toBe('b');
    // A freshly restarted node's first reading has no delta: not saturated.
    expect(pick([node(f, 'c', { cpu: null })], KNOBS, NOW).node?.id).toBe('c');
  });

  it('active at the limit refuses; frozen sandboxes are not counted', () => {
    const f = fleet().fleet;
    expect(pick([node(f, 'a', { active: 400 })], KNOBS, NOW).node).toBeNull();
    expect(pick([node(f, 'b', { active: 399 })], KNOBS, NOW).node?.id).toBe(
      'b',
    );
    // Thousands of frozen sandboxes are the normal shape of a node.
    expect(
      pick([node(f, 'c', { active: 1, frozen: 14_000 })], KNOBS, NOW).node?.id,
    ).toBe('c');
  });

  it('counts what was placed since the reading, so a burst inside one interval cannot overfill a node', () => {
    const f = fleet().fleet;
    const a = node(f, 'a', { active: 390 });
    expect(pick([a], KNOBS, NOW).node?.id).toBe('a');
    a.placedSinceCheckIn = 10;
    expect(pick([a], KNOBS, NOW).node).toBeNull();
    expect(pick([a], KNOBS, NOW).refused[0]?.reason).toMatch(
      /390 active sandboxes \+ 10 placed since the reading reach the 400 limit/,
    );
  });

  it('a data disk below the floor refuses, naming the GiB; a missing disk reading passes', () => {
    const f = fleet().fleet;
    const full = node(f, 'full', { diskAvail: 9 * 2 ** 30, memAvail: 30e9 });
    const room = node(f, 'room', { diskAvail: 50 * 2 ** 30, memAvail: 20e9 });
    expect(pick([full, room], KNOBS, NOW).node?.id).toBe('room');
    expect(pick([full], KNOBS, NOW).refused).toEqual([
      {
        nodeId: 'full',
        reason: 'data disk has 9.0 GiB available, below the 10.0 GiB floor',
      },
    ]);
    expect(
      pick([node(f, 'unknown', { diskAvail: null })], KNOBS, NOW).node?.id,
    ).toBe('unknown');
  });

  it('scores by active density — (active + placed) per core — then by available memory, then id', () => {
    const f = fleet().fleet;
    // Fewer sandboxes per core beats more free memory: memory is a
    // fifteen-second-old reading, the count moves with every pick.
    const a = node(f, 'a', { memAvail: 8e9, active: 5 });
    const b = node(f, 'b', { memAvail: 16e9, active: 50 });
    expect(pick([a, b], KNOBS, NOW).node?.id).toBe('a');
    // Equal density: the most available memory, then the id.
    const c = node(f, 'c', { memAvail: 16e9, active: 5 });
    expect(pick([a, b, c], KNOBS, NOW).node?.id).toBe('c');
    const d = node(f, 'd', { memAvail: 16e9, active: 5 });
    expect(pick([d, c], KNOBS, NOW).node?.id).toBe('c');
    // Per core: 40 sandboxes on 64 cores is emptier than 6 on 8.
    const big = node(f, 'big', { cores: 64, active: 40, memAvail: 1e9 });
    const small = node(f, 'small', { cores: 8, active: 6, memAvail: 64e9 });
    expect(pick([small, big], KNOBS, NOW).node?.id).toBe('big');
  });

  it('a burst inside one reading spreads: each pick counts against the node it chose, so the next pick sees it fuller', () => {
    const f = fleet().fleet;
    const a = node(f, 'a', { memAvail: 17e9, active: 350 });
    const b = node(f, 'b', { memAvail: 16e9, active: 10 });
    const landed = { a: 0, b: 0 };
    for (let i = 0; i < 100; i++) {
      const chosen = pick([a, b], KNOBS, NOW).node;
      if (chosen === null) throw new Error('every node refused');
      chosen.placedSinceCheckIn += 1;
      landed[chosen.id as 'a' | 'b'] += 1;
    }
    expect(landed).toEqual({ a: 0, b: 100 });
    // And with equal readings the two alternate.
    const c = node(f, 'c', { active: 10 });
    const d = node(f, 'd', { active: 10 });
    const alternating: string[] = [];
    for (let i = 0; i < 6; i++) {
      const chosen = pick([c, d], KNOBS, NOW).node;
      if (chosen === null) throw new Error('every node refused');
      chosen.placedSinceCheckIn += 1;
      alternating.push(chosen.id);
    }
    expect(alternating).toEqual(['c', 'd', 'c', 'd', 'c', 'd']);
  });

  it('refuses a node silent for two of its intervals, or one that never checked in — from the rows after a restart as from memory before', () => {
    const { db, fleet: f } = fleet();
    const stale = node(f, 'stale', {
      intervalSeconds: 15,
      checkedInAt: new Date(NOW.getTime() - 31_000),
    });
    const fresh = node(f, 'fresh', {
      intervalSeconds: 15,
      checkedInAt: new Date(NOW.getTime() - 29_000),
    });
    const before = pick([stale, fresh], KNOBS, NOW);
    expect(before.node?.id).toBe('fresh');
    expect(before.refused).toEqual([
      { nodeId: 'stale', reason: 'has not checked in for 31s' },
    ]);
    // The same rows after a gateway restart, plus one the import
    // pre-created: each judged by the check-in its row kept — the fresh
    // one is placed on at once, the stale one refused as before, the
    // never-heard-from one refused with the word for it.
    db.insert(nodes)
      .values({
        id: 'new',
        endpoint: 'http://new:80',
        addedAt: NOW.toISOString(),
      })
      .run();
    const restarted = new Fleet(db);
    const result = pick(restarted.all(), KNOBS, NOW);
    expect(result.node?.id).toBe('fresh');
    expect(
      Object.fromEntries(result.refused.map((r) => [r.nodeId, r.reason])),
    ).toEqual({
      stale: 'has not checked in for 31s',
      new: 'has never checked in',
    });
  });

  it('when every node refuses, each refusal names the node and its reason for the 503; no node at all says so', () => {
    const f = fleet().fleet;
    const result = pick(
      [
        node(f, 'a', { cpu: 90, active: 100, memAvail: 1e9 }),
        node(f, 'b', { cpu: 20, active: 400, memAvail: 2e9 }),
      ],
      KNOBS,
      NOW,
    );
    expect(result.node).toBeNull();
    expect(result.refused).toEqual([
      { nodeId: 'a', reason: 'cpu 90% is above the 70% limit' },
      {
        nodeId: 'b',
        reason:
          '400 active sandboxes + 0 placed since the reading reach the 400 limit',
      },
    ]);
    expect(refusalMessage(result)).toBe(
      'no node can take a new sandbox right now — a: cpu 90% is above the 70% limit; b: 400 active sandboxes + 0 placed since the reading reach the 400 limit',
    );
    expect(refusalMessage(pick([], KNOBS, NOW))).toMatch(
      /no node has checked in/,
    );
  });
});
