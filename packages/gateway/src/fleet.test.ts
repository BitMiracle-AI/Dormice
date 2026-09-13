import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrateDb, openDb } from './db/db';
import { downReason, Fleet } from './fleet';
import { checkInOf } from './testing';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const NOW = new Date('2026-09-14T12:00:00.000Z');

function db() {
  const handle = openDb(':memory:');
  migrateDb(handle, MIGRATIONS);
  return handle;
}

describe('Fleet', () => {
  it('a first check-in joins the node and persists its row; a gateway restart still knows it, unreached until it checks in again', () => {
    const handle = db();
    const fleet = new Fleet(handle);
    expect(fleet.all()).toEqual([]);
    const { node, joined } = fleet.checkIn(
      checkInOf('node-b', 'http://10.0.0.7:80', { intervalSeconds: 15 }),
      NOW,
    );
    expect(joined).toBe(true);
    expect(node.addedAt).toBe(NOW.toISOString());
    expect(node.lastCheckInAt).toBe(NOW);
    expect(node.reading?.host.cpuCount).toBe(8);
    expect(downReason(node, NOW)).toBeNull();

    // The same database after a restart: the row is there, the memory is not.
    const restarted = new Fleet(handle);
    const known = restarted.get('node-b');
    expect(known?.endpoint).toBe('http://10.0.0.7:80');
    expect(known?.addedAt).toBe(NOW.toISOString());
    expect(known?.reading).toBeNull();
    expect(downReason(known as NonNullable<typeof known>, NOW)).toBe(
      'has not checked in since the gateway started',
    );
  });

  it('a later check-in is not a join; a changed endpoint is written through; the placement counter restarts', () => {
    const handle = db();
    const fleet = new Fleet(handle);
    const first = fleet.checkIn(checkInOf('node-b', 'http://10.0.0.7:80'), NOW);
    first.node.placedSinceCheckIn = 3;
    const second = fleet.checkIn(
      checkInOf('node-b', 'http://10.0.0.8:80', { active: 12 }),
      new Date(NOW.getTime() + 15_000),
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
    const { node } = fleet.checkIn(
      checkInOf('node-b', 'http://10.0.0.7:80', { intervalSeconds: 15 }),
      NOW,
    );
    expect(downReason(node, new Date(NOW.getTime() + 29_000))).toBeNull();
    expect(downReason(node, new Date(NOW.getTime() + 31_000))).toBe(
      'has not checked in for 31s',
    );
    // A one-second node (the exam's) is judged by its own interval.
    const quick = fleet.checkIn(
      checkInOf('node-c', 'http://10.0.0.9:80', { intervalSeconds: 1 }),
      NOW,
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
      fleet.checkIn(checkInOf('node-b', 'http://10.0.0.7:80'), NOW).joined,
    ).toBe(true);
  });
});
