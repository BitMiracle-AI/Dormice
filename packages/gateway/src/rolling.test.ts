import { fileURLToPath } from 'node:url';
import type { BuildInfo } from '@dormice/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { migrateDb, openDb } from './db/db';
import { nodes } from './db/schema';
import { Fleet, type NodeState } from './fleet';
import {
  Rolling,
  rollingDecision,
  UPGRADE_TOLD_TIMEOUT_MS,
  upgradeStateOf,
} from './rolling';
import { checkInOf } from './testing';

// The fleet upgrade's rules, pure: every state a node can stand in
// against the gateway's build, and who is told when. The wire (the
// check-in's answer, the routes) is routes/upgrade.test.ts's.

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const NOW = new Date('2026-09-15T12:00:00.000Z');
const GATEWAY: BuildInfo = {
  commit: 'new0001',
  title: 'the new build',
  committedAt: '2026-09-15T00:00:00.000Z',
};
const OLD: BuildInfo = {
  commit: 'old0001',
  title: 'the old build',
  committedAt: '2026-09-14T00:00:00.000Z',
};
/** A commit that landed on main after the gateway upgraded — where a node told mid-roll ends up. */
const NEWER: BuildInfo = {
  commit: 'new0002',
  title: 'landed on main mid-roll',
  committedAt: '2026-09-15T00:05:00.000Z',
};
const CAN = { available: true, reason: null, running: false };
const CANNOT = {
  available: false,
  reason:
    'systemd-run is not available — one-click upgrade needs a systemd host',
  running: false,
};
/** A node whose machine has an upgrade unit alive: its previous upgrade finishing, or install.sh by hand. */
const BUSY = { ...CAN, running: true };

function fleetOver() {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  return { db, fleet: new Fleet(db) };
}

function reporting(
  fleet: Fleet,
  id: string,
  over: Parameters<typeof checkInOf>[2] = {},
  at = NOW,
): NodeState {
  const outcome = fleet.checkIn(checkInOf(id, `http://${id}:80`, over), at);
  if ('refused' in outcome) throw new Error(outcome.refused);
  return outcome.node;
}

describe('upgradeStateOf', () => {
  it('current on the same commit; behind on another when the node can upgrade itself and was not told', () => {
    const { fleet } = fleetOver();
    const same = reporting(fleet, 'a', { build: GATEWAY, selfUpgrade: CAN });
    expect(upgradeStateOf(same, GATEWAY, NOW)).toEqual({
      state: 'current',
      reason: null,
    });
    const behind = reporting(fleet, 'b', { build: OLD, selfUpgrade: CAN });
    expect(upgradeStateOf(behind, GATEWAY, NOW)).toEqual({
      state: 'behind',
      reason: null,
    });
  });

  it('unknown when either side has no build identity; a row that never checked in says so', () => {
    const { db, fleet } = fleetOver();
    const node = reporting(fleet, 'a', { build: OLD, selfUpgrade: CAN });
    expect(upgradeStateOf(node, null, NOW)).toMatchObject({
      state: 'unknown',
      reason: expect.stringMatching(/gateway carries no build identity/),
    });
    const bare = reporting(fleet, 'b', { build: null, selfUpgrade: CAN });
    expect(upgradeStateOf(bare, GATEWAY, NOW)).toMatchObject({
      state: 'unknown',
      reason: expect.stringMatching(/node reports no build identity/),
    });
    db.insert(nodes)
      .values({ id: 'n', endpoint: 'http://n:80', addedAt: NOW.toISOString() })
      .run();
    const never = new Fleet(db).get('n');
    if (!never) throw new Error('row lost');
    expect(upgradeStateOf(never, GATEWAY, NOW)).toEqual({
      state: 'unknown',
      reason: 'the node has never checked in',
    });
  });

  it('unreachable outranks behind and current: a node two of its intervals silent is not judged on its build — unless it was told, whose silence is the restart', () => {
    const { fleet } = fleetOver();
    const later = new Date(NOW.getTime() + 31_000);
    const node = reporting(fleet, 'a', { build: OLD, selfUpgrade: CAN });
    expect(upgradeStateOf(node, GATEWAY, later)).toEqual({
      state: 'unreachable',
      reason: 'has not checked in for 31s',
    });
    const current = reporting(fleet, 'b', { build: GATEWAY, selfUpgrade: CAN });
    expect(upgradeStateOf(current, GATEWAY, later).state).toBe('unreachable');
    fleet.setUpgradeTold('a', { at: NOW, build: OLD.commit });
    expect(upgradeStateOf(node, GATEWAY, later)).toEqual({
      state: 'upgrading',
      reason: 'told 31s ago, still on old0001 (has not checked in for 31s)',
    });
  });

  it("unavailable, with the node's own reason, when it cannot upgrade itself — or did not say", () => {
    const { fleet } = fleetOver();
    const cannot = reporting(fleet, 'a', { build: OLD, selfUpgrade: CANNOT });
    expect(upgradeStateOf(cannot, GATEWAY, NOW)).toEqual({
      state: 'unavailable',
      reason: `${CANNOT.reason} — run install.sh on it`,
    });
    const silent = reporting(fleet, 'b', { build: OLD });
    expect(upgradeStateOf(silent, GATEWAY, NOW)).toMatchObject({
      state: 'unavailable',
      reason: expect.stringMatching(
        /runs old0001 and does not say whether it can upgrade itself/,
      ),
    });
  });

  it("ahead, never told, when the node's build is newer than the gateway's; silent, it is unreachable like any other; a same-second tie reads behind", () => {
    const { fleet } = fleetOver();
    const node = reporting(fleet, 'a', { build: NEWER, selfUpgrade: CAN });
    expect(upgradeStateOf(node, GATEWAY, NOW)).toEqual({
      state: 'ahead',
      reason:
        "runs new0002 (committed 2026-09-15T00:05:00.000Z), newer than the gateway's new0001 — a fleet upgrades from its gateway: upgrade the gateway (applyUpgrade there), and this node reads current",
    });
    expect(rollingDecision(fleet.all(), GATEWAY, node, NOW)).toBe(false);
    expect(
      upgradeStateOf(node, GATEWAY, new Date(NOW.getTime() + 31_000)),
    ).toEqual({ state: 'unreachable', reason: 'has not checked in for 31s' });
    // The commit's time is the order; two commits in one second cannot be
    // told apart, and the tie reads behind.
    const tied = reporting(fleet, 'b', {
      build: { ...GATEWAY, commit: 'tie0001' },
      selfUpgrade: CAN,
    });
    expect(upgradeStateOf(tied, GATEWAY, NOW).state).toBe('behind');
  });

  it('told: upgrading within the timeout, stuck past it — with when it was told, what it still runs, and where to look', () => {
    const { fleet } = fleetOver();
    const node = reporting(fleet, 'a', { build: OLD, selfUpgrade: CAN });
    fleet.setUpgradeTold('a', { at: NOW, build: OLD.commit });
    const soon = new Date(NOW.getTime() + 90_000);
    // Still checking in during its build: upgrading, plainly.
    reporting(fleet, 'a', { build: OLD, selfUpgrade: CAN }, soon);
    expect(upgradeStateOf(node, GATEWAY, soon)).toEqual({
      state: 'upgrading',
      reason: 'told 90s ago, still on old0001',
    });
    const late = new Date(NOW.getTime() + UPGRADE_TOLD_TIMEOUT_MS);
    reporting(fleet, 'a', { build: OLD, selfUpgrade: CAN }, late);
    expect(upgradeStateOf(node, GATEWAY, late)).toMatchObject({
      state: 'stuck',
      reason: expect.stringMatching(
        /^told to upgrade at 2026-09-15T12:00:00\.000Z and still on old0001 20 minutes later — read journalctl -u dormice-upgrade/,
      ),
    });
    // Back on the gateway's build: current, whatever the tell says.
    reporting(fleet, 'a', { build: GATEWAY, selfUpgrade: CAN }, late);
    expect(upgradeStateOf(node, GATEWAY, late).state).toBe('current');
  });
});

describe('rollingDecision', () => {
  it('tells a node behind when no other is upgrading; not while one is; a stuck one does not hold the pointer', () => {
    const { fleet } = fleetOver();
    const a = reporting(fleet, 'a', { build: OLD, selfUpgrade: CAN });
    const b = reporting(fleet, 'b', { build: OLD, selfUpgrade: CAN });
    const all = fleet.all();
    expect(rollingDecision(all, GATEWAY, a, NOW)).toBe(true);
    fleet.setUpgradeTold('a', { at: NOW, build: OLD.commit });
    expect(rollingDecision(all, GATEWAY, b, NOW)).toBe(false);
    // a restarts near the end of its upgrade and misses check-ins: still
    // upgrading, and b still waits.
    const restarting = new Date(NOW.getTime() + 60_000);
    reporting(fleet, 'b', { build: OLD, selfUpgrade: CAN }, restarting);
    expect(rollingDecision(all, GATEWAY, b, restarting)).toBe(false);
    // Twenty minutes on, a is stuck, not upgrading: b's turn comes.
    const late = new Date(NOW.getTime() + UPGRADE_TOLD_TIMEOUT_MS);
    reporting(fleet, 'b', { build: OLD, selfUpgrade: CAN }, late);
    expect(rollingDecision(all, GATEWAY, b, late)).toBe(true);
    // And a stuck node is never told again on its own.
    reporting(fleet, 'a', { build: OLD, selfUpgrade: CAN }, late);
    expect(rollingDecision(all, GATEWAY, a, late)).toBe(false);
  });

  it('never tells a node that is current, unavailable, unreachable or unknown', () => {
    const { fleet } = fleetOver();
    const current = reporting(fleet, 'a', { build: GATEWAY, selfUpgrade: CAN });
    const cannot = reporting(fleet, 'b', { build: OLD, selfUpgrade: CANNOT });
    const bare = reporting(fleet, 'c', { build: null, selfUpgrade: CAN });
    const gone = reporting(fleet, 'd', { build: OLD, selfUpgrade: CAN });
    gone.lastCheckInAt = new Date(NOW.getTime() - 40_000);
    for (const node of [current, cannot, bare, gone]) {
      expect(rollingDecision(fleet.all(), GATEWAY, node, NOW)).toBe(false);
    }
    expect(rollingDecision(fleet.all(), null, cannot, NOW)).toBe(false);
  });
});

describe('Rolling', () => {
  it('onCheckIn tells once and writes the tell to the row; a fulfilled tell is cleared; a restart remembers who was told', () => {
    const { db, fleet } = fleetOver();
    const rolling = new Rolling(fleet, GATEWAY);
    const a = reporting(fleet, 'a', { build: OLD, selfUpgrade: CAN });
    const b = reporting(fleet, 'b', { build: OLD, selfUpgrade: CAN });
    expect(rolling.onCheckIn(a, NOW)).toBe(true);
    expect(a.upgradeTold).toEqual({ at: NOW, build: OLD.commit });
    expect(rolling.onCheckIn(b, NOW)).toBe(false);
    // a's next check-in, still old: not told again.
    const later = new Date(NOW.getTime() + 15_000);
    reporting(fleet, 'a', { build: OLD, selfUpgrade: CAN }, later);
    expect(rolling.onCheckIn(a, later)).toBe(false);
    // The row remembers across a restart.
    const restarted = new Fleet(db);
    expect(restarted.get('a')?.upgradeTold).toEqual({
      at: NOW,
      build: OLD.commit,
    });
    expect(new Rolling(restarted, GATEWAY).states(later)).toMatchObject([
      { id: 'a', state: 'upgrading', toldAt: NOW.toISOString() },
      { id: 'b', state: 'behind', toldAt: null },
    ]);
    // a comes back on the new build: its tell is fulfilled and cleared,
    // and b's turn comes at its next check-in.
    reporting(fleet, 'a', { build: GATEWAY, selfUpgrade: CAN }, later);
    expect(rolling.onCheckIn(a, later)).toBe(false);
    expect(a.upgradeTold).toBeNull();
    expect(new Fleet(db).get('a')?.upgradeTold).toBeNull();
    expect(rolling.onCheckIn(b, later)).toBe(true);
  });

  it("unstick forgets a stuck node's tell: it reads behind, waits for the node upgrading and is told at its turn; every other state is refused in words", () => {
    const { db, fleet } = fleetOver();
    const rolling = new Rolling(fleet, GATEWAY);
    const a = reporting(fleet, 'a', { build: OLD, selfUpgrade: CAN });
    const b = reporting(fleet, 'b', { build: OLD, selfUpgrade: CAN });
    expect(rolling.onCheckIn(a, NOW)).toBe(true);
    expect(rolling.onCheckIn(b, NOW)).toBe(false);
    // b is behind and in line already; a is upgrading and its tell is the
    // one-at-a-time rule's count — neither is the hand's to touch.
    expect(rolling.unstick(b, NOW)).toMatchObject({
      status: 400,
      message: expect.stringMatching(/behind and in line/),
    });
    expect(rolling.unstick(a, NOW)).toMatchObject({
      status: 409,
      message: expect.stringMatching(
        /is upgrading \(told 0s ago, still on old0001\)/,
      ),
    });
    expect(a.upgradeTold).toEqual({ at: NOW, build: OLD.commit });
    // Twenty minutes on, a is stuck and b's turn came.
    const late = new Date(NOW.getTime() + UPGRADE_TOLD_TIMEOUT_MS);
    reporting(fleet, 'a', { build: OLD, selfUpgrade: CAN }, late);
    reporting(fleet, 'b', { build: OLD, selfUpgrade: CAN }, late);
    expect(rolling.onCheckIn(a, late)).toBe(false);
    expect(rolling.onCheckIn(b, late)).toBe(true);
    // The hand: a's tell is forgotten on the row, and a reads behind.
    expect(rolling.unstick(a, late)).toBeNull();
    expect(a.upgradeTold).toBeNull();
    expect(new Fleet(db).get('a')?.upgradeTold).toBeNull();
    expect(upgradeStateOf(a, GATEWAY, late).state).toBe('behind');
    // Not past b: a waits while b upgrades, and is told once b is back.
    expect(rolling.onCheckIn(a, late)).toBe(false);
    reporting(fleet, 'b', { build: GATEWAY, selfUpgrade: CAN }, late);
    expect(rolling.onCheckIn(b, late)).toBe(false);
    expect(rolling.onCheckIn(a, late)).toBe(true);
    expect(a.upgradeTold).toEqual({ at: late, build: OLD.commit });

    const current = reporting(
      fleet,
      'c',
      { build: GATEWAY, selfUpgrade: CAN },
      late,
    );
    expect(rolling.unstick(current, late)).toMatchObject({
      status: 400,
      message: expect.stringMatching(/already runs the gateway's build/),
    });
    const cannot = reporting(
      fleet,
      'd',
      { build: OLD, selfUpgrade: CANNOT },
      late,
    );
    expect(rolling.unstick(cannot, late)).toMatchObject({
      status: 400,
      message: expect.stringMatching(/cannot be told to upgrade: systemd-run/),
    });
    const gone = reporting(fleet, 'e', { build: OLD, selfUpgrade: CAN }, late);
    gone.lastCheckInAt = new Date(late.getTime() - 40_000);
    expect(rolling.unstick(gone, late)).toMatchObject({
      status: 400,
      message: expect.stringMatching(/not checking in/),
    });
    expect(new Rolling(fleet, null).unstick(a, late)).toMatchObject({
      status: 400,
      message: expect.stringMatching(/gateway carries no build identity/),
    });
  });

  it('a told node that comes back on another commit than it was told on has fulfilled its tell, even when the gateway moved on meanwhile: cleared, behind again, and told again at its turn — not upgrading, not stuck', () => {
    const { db, fleet } = fleetOver();
    // The gateway was on GATEWAY when a was told; a pulled that head and
    // built. Before it came back, the gateway's machine was upgraded
    // again (a fix pushed minutes after the first), so the gateway now
    // runs NEWER and a comes back on GATEWAY — older than the gateway's.
    const first = new Rolling(fleet, GATEWAY);
    const a = reporting(fleet, 'a', { build: OLD, selfUpgrade: CAN });
    const b = reporting(fleet, 'b', { build: OLD, selfUpgrade: CAN });
    expect(first.onCheckIn(a, NOW)).toBe(true);
    expect(a.upgradeTold).toEqual({ at: NOW, build: OLD.commit });
    expect(new Fleet(db).get('a')?.upgradeTold).toEqual({
      at: NOW,
      build: OLD.commit,
    });
    const rolling = new Rolling(fleet, NEWER);
    const back = new Date(NOW.getTime() + 70_000);
    // Its tell stands while it still reports the commit it was told on.
    expect(upgradeStateOf(a, NEWER, back)).toMatchObject({
      state: 'upgrading',
    });
    reporting(fleet, 'b', { build: OLD, selfUpgrade: CAN }, back);
    expect(rolling.onCheckIn(b, back)).toBe(false);
    // Back on GATEWAY: another commit than told on — fulfilled. Not
    // upgrading, not stuck; behind the gateway's NEWER, and told again at
    // once, nobody else being mid-upgrade.
    reporting(fleet, 'a', { build: GATEWAY, selfUpgrade: CAN }, back);
    expect(upgradeStateOf(a, NEWER, back)).toEqual({
      state: 'behind',
      reason: null,
    });
    expect(rolling.onCheckIn(a, back)).toBe(true);
    expect(a.upgradeTold).toEqual({ at: back, build: GATEWAY.commit });
    expect(rolling.states(back)).toMatchObject([
      { id: 'a', state: 'upgrading', toldAt: back.toISOString() },
      { id: 'b', state: 'behind', toldAt: null },
    ]);
    // Twenty minutes on the same commit is stuck, as before — and now the
    // reason's "still on" is true by construction.
    const late = new Date(back.getTime() + UPGRADE_TOLD_TIMEOUT_MS);
    reporting(fleet, 'a', { build: GATEWAY, selfUpgrade: CAN }, late);
    expect(upgradeStateOf(a, NEWER, late)).toMatchObject({
      state: 'stuck',
      reason: expect.stringMatching(/still on new0001 20 minutes later/),
    });
    // A row from before the commit was recorded (migration 0006) holding
    // a tell without one is read as no tell: the node stands as its
    // build says.
    reporting(fleet, 'c', { build: OLD, selfUpgrade: CAN }, late);
    fleet.setUpgradeTold('c', { at: late, build: OLD.commit });
    db.update(nodes)
      .set({ upgradeToldBuild: null })
      .where(eq(nodes.id, 'c'))
      .run();
    const cOld = new Fleet(db).get('c');
    if (!cOld) throw new Error('row lost');
    expect(cOld.upgradeTold).toBeNull();
    expect(upgradeStateOf(cOld, NEWER, late).state).toBe('behind');
  });

  it('a told node that reads current or ahead while still on the commit it was told on — the gateway went back to an older build — has its tell forgotten, so it is not read stuck the day the gateway passes it again', () => {
    const { fleet } = fleetOver();
    const a = reporting(fleet, 'a', { build: GATEWAY, selfUpgrade: CAN });
    const first = new Rolling(fleet, NEWER);
    expect(first.onCheckIn(a, NOW)).toBe(true);
    // The gateway's machine is put back on GATEWAY by hand: a reads
    // current, still on the commit it was told on, and the tell goes.
    const back = new Rolling(fleet, GATEWAY);
    const later = new Date(NOW.getTime() + 60_000);
    reporting(fleet, 'a', { build: GATEWAY, selfUpgrade: CAN }, later);
    expect(back.onCheckIn(a, later)).toBe(false);
    expect(a.upgradeTold).toBeNull();
    // Further back, to OLD: a reads ahead, and a tell would go the same way.
    fleet.setUpgradeTold('a', { at: NOW, build: GATEWAY.commit });
    expect(new Rolling(fleet, OLD).onCheckIn(a, later)).toBe(false);
    expect(a.upgradeTold).toBeNull();
    // Twenty minutes on, the gateway is on NEWER again: a is behind and
    // told afresh — not stuck on a tell from before the detour.
    const late = new Date(NOW.getTime() + UPGRADE_TOLD_TIMEOUT_MS + 60_000);
    reporting(fleet, 'a', { build: GATEWAY, selfUpgrade: CAN }, late);
    expect(upgradeStateOf(a, NEWER, late).state).toBe('behind');
    expect(first.onCheckIn(a, late)).toBe(true);
  });

  it('a told node that comes back newer than the gateway is ahead: its tell is fulfilled and cleared, it is not told again, the hand refuses it, and it holds nobody', () => {
    const { db, fleet } = fleetOver();
    const rolling = new Rolling(fleet, GATEWAY);
    const a = reporting(fleet, 'a', { build: OLD, selfUpgrade: CAN });
    expect(rolling.onCheckIn(a, NOW)).toBe(true);
    // Its install.sh pulled main's head, which moved on since the gateway
    // upgraded: back on a newer build than the gateway's.
    const later = new Date(NOW.getTime() + 120_000);
    reporting(fleet, 'a', { build: NEWER, selfUpgrade: CAN }, later);
    expect(rolling.onCheckIn(a, later)).toBe(false);
    expect(a.upgradeTold).toBeNull();
    expect(new Fleet(db).get('a')?.upgradeTold).toBeNull();
    expect(rolling.states(later)).toMatchObject([
      { id: 'a', state: 'ahead', toldAt: null },
    ]);
    expect(rolling.unstick(a, later)).toMatchObject({
      status: 400,
      message: expect.stringMatching(
        /cannot be told to upgrade: runs new0002 .* newer than the gateway's new0001/,
      ),
    });
    // Not upgrading, so it holds no pointer: b's turn comes.
    const b = reporting(fleet, 'b', { build: OLD, selfUpgrade: CAN }, later);
    expect(rolling.onCheckIn(b, later)).toBe(true);
  });

  it('a node that says an upgrade unit is running on it is upgrading, told or not: not told, counted by the one-at-a-time rule, the hand refused, a fulfilled tell on it still forgotten — and told at the first check-in that says the unit has ended', () => {
    const { fleet } = fleetOver();
    const rolling = new Rolling(fleet, NEWER);
    // a was told on OLD by a gateway then on GATEWAY, pulled and built
    // GATEWAY, restarted — and its first check-in back finds the gateway
    // on NEWER already, while its own installer still runs doctor.
    const a = reporting(fleet, 'a', { build: OLD, selfUpgrade: CAN });
    fleet.setUpgradeTold('a', { at: NOW, build: OLD.commit });
    const back = new Date(NOW.getTime() + 70_000);
    reporting(fleet, 'a', { build: GATEWAY, selfUpgrade: BUSY }, back);
    expect(upgradeStateOf(a, NEWER, back)).toEqual({
      state: 'upgrading',
      reason: expect.stringMatching(
        /^an upgrade unit is running on the node \(dormice-upgrade\)/,
      ),
    });
    expect(rolling.onCheckIn(a, back)).toBe(false);
    // The tell it fulfilled is gone from the row, upgrading or not.
    expect(a.upgradeTold).toBeNull();
    // b, behind, waits: a's unit is the count.
    const b = reporting(fleet, 'b', { build: OLD, selfUpgrade: CAN }, back);
    expect(rolling.onCheckIn(b, back)).toBe(false);
    expect(rolling.unstick(a, back)).toMatchObject({
      status: 409,
      message: expect.stringMatching(
        /not on a tell, so nothing to put back in line/,
      ),
    });
    // The unit ends: a says so at its next check-in, reads behind, and is
    // told — on the commit it now runs.
    const ended = new Date(back.getTime() + 15_000);
    reporting(fleet, 'a', { build: GATEWAY, selfUpgrade: CAN }, ended);
    expect(rolling.onCheckIn(a, ended)).toBe(true);
    expect(a.upgradeTold).toEqual({ at: ended, build: GATEWAY.commit });
    // Told and its unit alive: upgrading on its tell, the unit said
    // beside it; twenty minutes on, stuck — a build that hangs.
    const hung = new Date(ended.getTime() + 30_000);
    reporting(fleet, 'a', { build: GATEWAY, selfUpgrade: BUSY }, hung);
    expect(upgradeStateOf(a, NEWER, hung)).toEqual({
      state: 'upgrading',
      reason:
        'told 30s ago, still on new0001 (an upgrade unit is running on it)',
    });
    const late = new Date(ended.getTime() + UPGRADE_TOLD_TIMEOUT_MS);
    reporting(fleet, 'a', { build: GATEWAY, selfUpgrade: BUSY }, late);
    expect(upgradeStateOf(a, NEWER, late)).toMatchObject({
      state: 'stuck',
      reason: expect.stringMatching(
        /20 minutes later \(an upgrade unit is running on it\)/,
      ),
    });
    // Quiet for good after saying "running", and no tell to clock it:
    // unreachable, not upgrading forever.
    fleet.setUpgradeTold('a', null);
    a.lastCheckInAt = new Date(late.getTime() - 40_000);
    expect(upgradeStateOf(a, NEWER, late).state).toBe('unreachable');
  });

  it('states lists every node in id order with its standing, build and tell', () => {
    const { fleet } = fleetOver();
    const rolling = new Rolling(fleet, GATEWAY);
    reporting(fleet, 'c', { build: GATEWAY, selfUpgrade: CAN });
    const a = reporting(fleet, 'a', { build: OLD, selfUpgrade: CAN });
    reporting(fleet, 'b', { build: OLD });
    expect(rolling.onCheckIn(a, NOW)).toBe(true);
    expect(rolling.states(new Date(NOW.getTime() + 5_000))).toEqual([
      {
        id: 'a',
        build: OLD,
        state: 'upgrading',
        toldAt: NOW.toISOString(),
        reason: 'told 5s ago, still on old0001',
      },
      {
        id: 'b',
        build: OLD,
        state: 'unavailable',
        toldAt: null,
        reason: expect.stringMatching(/does not say whether it can upgrade/),
      },
      { id: 'c', build: GATEWAY, state: 'current', toldAt: null, reason: null },
    ]);
  });
});
