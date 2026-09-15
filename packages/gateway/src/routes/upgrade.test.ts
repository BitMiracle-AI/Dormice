import type { BuildInfo } from '@dormice/shared';
import {
  checkInResponseSchema,
  checkUpgradeResponseSchema,
  getUpgradeStatusResponseSchema,
} from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { UPGRADE_TOLD_TIMEOUT_MS } from '../rolling';
import { checkInOf, TEST_TOKEN, testGateway } from '../testing';

// The fleet upgrade over the wire: the check-in that carries the tell,
// the three verbs at the door. The rules themselves are rolling.test.ts's;
// the launch of install.sh is the daemon's updater suite's — here the
// gateway runs from no checkout, so applyUpgrade without a node is the
// honest 400 and nothing reaches systemd.

const authed = { authorization: `Bearer ${TEST_TOKEN}` };
type App = ReturnType<typeof testGateway>['app'];

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
const CAN = { available: true, reason: null };

function rpc(
  app: App,
  url: string,
  payload: object = {},
  headers: Record<string, string> = authed,
) {
  return app.inject({ method: 'POST', url, headers, payload });
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
  return checkInResponseSchema.parse(res.json());
}

async function status(app: App) {
  const res = await rpc(app, '/getUpgradeStatus');
  expect(res.statusCode).toBe(200);
  return getUpgradeStatusResponseSchema.parse(res.json());
}

describe('the fleet upgrade over the check-in', () => {
  it("a node on another build is told once, the next one waits, and the answer stops telling once the node is back on the gateway's build", async () => {
    const { app, fleet } = testGateway({}, { build: GATEWAY });
    // Both behind. a checks in first: told. b: not while a upgrades.
    expect(
      (await checkIn(app, 'a', { build: OLD, selfUpgrade: CAN })).upgrade,
    ).toBe(true);
    expect(
      (await checkIn(app, 'b', { build: OLD, selfUpgrade: CAN })).upgrade,
    ).toBeUndefined();
    // a again, still old: told once, not twice.
    expect(
      (await checkIn(app, 'a', { build: OLD, selfUpgrade: CAN })).upgrade,
    ).toBeUndefined();
    expect((await status(app)).nodes).toMatchObject([
      { id: 'a', state: 'upgrading' },
      { id: 'b', state: 'behind' },
    ]);
    // a is back on the new build: current, and b's turn.
    expect(
      (await checkIn(app, 'a', { build: GATEWAY, selfUpgrade: CAN })).upgrade,
    ).toBeUndefined();
    expect(
      (await checkIn(app, 'b', { build: OLD, selfUpgrade: CAN })).upgrade,
    ).toBe(true);
    expect((await status(app)).nodes).toMatchObject([
      { id: 'a', state: 'current', toldAt: null },
      { id: 'b', state: 'upgrading' },
    ]);
    // The tell rides beside a bundle when one is due, on the same answer.
    const { app: app2 } = testGateway({}, { build: GATEWAY });
    const answer = await checkIn(app2, 'c', {
      build: OLD,
      selfUpgrade: CAN,
      configVersion: null,
    });
    expect(answer.config).toBeDefined();
    expect(answer.upgrade).toBe(true);
    void fleet;
  });

  it('a node still old twenty minutes after its tell is stuck and is not re-told; the operator re-tells it, and it hears at its next check-in', async () => {
    const { app, fleet } = testGateway({}, { build: GATEWAY });
    expect(
      (await checkIn(app, 'a', { build: OLD, selfUpgrade: CAN })).upgrade,
    ).toBe(true);
    const a = fleet.get('a');
    if (!a) throw new Error('node lost');
    a.upgradeToldAt = new Date(Date.now() - UPGRADE_TOLD_TIMEOUT_MS - 1000);
    expect(
      (await checkIn(app, 'a', { build: OLD, selfUpgrade: CAN })).upgrade,
    ).toBeUndefined();
    const stuck = (await status(app)).nodes?.find((n) => n.id === 'a');
    expect(stuck).toMatchObject({
      state: 'stuck',
      reason: expect.stringMatching(/still on old0001 2\d minutes later/),
    });
    // Meanwhile the pointer moved on: b is told.
    expect(
      (await checkIn(app, 'b', { build: OLD, selfUpgrade: CAN })).upgrade,
    ).toBe(true);
    // The operator's hand: a is told again at its next check-in, even
    // while b upgrades.
    const retold = await rpc(app, '/applyUpgrade', { nodeId: 'a' });
    expect(retold.statusCode).toBe(200);
    expect(retold.json()).toEqual({ started: true });
    expect(
      (await checkIn(app, 'a', { build: OLD, selfUpgrade: CAN })).upgrade,
    ).toBe(true);
    expect((await status(app)).nodes?.find((n) => n.id === 'a')?.state).toBe(
      'upgrading',
    );
  });

  it('nodes that cannot upgrade themselves, did not say, or carry no build are listed with the reason and never told', async () => {
    const { app } = testGateway({}, { build: GATEWAY });
    expect(
      (
        await checkIn(app, 'a', {
          build: OLD,
          selfUpgrade: {
            available: false,
            reason: 'the process does not run from a git checkout',
          },
        })
      ).upgrade,
    ).toBeUndefined();
    expect((await checkIn(app, 'b', { build: OLD })).upgrade).toBeUndefined();
    expect(
      (await checkIn(app, 'c', { build: null, selfUpgrade: CAN })).upgrade,
    ).toBeUndefined();
    expect((await status(app)).nodes).toEqual([
      expect.objectContaining({
        id: 'a',
        state: 'unavailable',
        reason:
          'the process does not run from a git checkout — run install.sh on it',
      }),
      expect.objectContaining({
        id: 'b',
        state: 'unavailable',
        reason: expect.stringMatching(/does not say whether it can upgrade/),
      }),
      expect.objectContaining({ id: 'c', state: 'unknown' }),
    ]);
    // A gateway without a build identity judges nobody.
    const { app: bare } = testGateway();
    expect(
      (await checkIn(bare, 'a', { build: OLD, selfUpgrade: CAN })).upgrade,
    ).toBeUndefined();
    expect((await status(bare)).nodes).toEqual([
      expect.objectContaining({
        id: 'a',
        state: 'unknown',
        reason: expect.stringMatching(/gateway carries no build identity/),
      }),
    ]);
  });
});

describe('the upgrade verbs at the door', () => {
  it("checkUpgrade answers the gateway's build and, running from no checkout, an honest checkError", async () => {
    const { app } = testGateway({}, { build: GATEWAY });
    const res = await rpc(app, '/checkUpgrade', {});
    expect(res.statusCode).toBe(200);
    expect(checkUpgradeResponseSchema.parse(res.json())).toEqual({
      current: GATEWAY,
      check: null,
      checkError: expect.stringMatching(/does not run from a git checkout/),
    });
  });

  it("getUpgradeStatus is the gateway machine's run plus the nodes; applyUpgrade without a node is the honest 400 here, with one names its refusals", async () => {
    const { app } = testGateway({}, { build: GATEWAY });
    await checkIn(app, 'a', { build: GATEWAY, selfUpgrade: CAN });
    const s = await status(app);
    expect(s).toMatchObject({
      available: false,
      unavailableReason: expect.stringMatching(/git checkout/),
      running: false,
      last: null,
      nodes: [{ id: 'a', state: 'current' }],
    });
    const fleetWide = await rpc(app, '/applyUpgrade', {});
    expect(fleetWide.statusCode).toBe(400);
    expect(fleetWide.json().message).toMatch(/one-click upgrade unavailable/);
    expect(
      (await rpc(app, '/applyUpgrade', { nodeId: 'ghost' })).statusCode,
    ).toBe(404);
    const current = await rpc(app, '/applyUpgrade', { nodeId: 'a' });
    expect(current.statusCode).toBe(400);
    expect(current.json().message).toMatch(/already runs the gateway's build/);
    expect((await rpc(app, '/applyUpgrade', { nodeId: '' })).statusCode).toBe(
      400,
    );
  });

  it('is admin-only: a minted key gets 403 on all three', async () => {
    const { app } = testGateway({}, { build: GATEWAY });
    const minted = (await rpc(app, '/createApiKey', { name: 'ci' })).json();
    for (const verb of ['checkUpgrade', 'applyUpgrade', 'getUpgradeStatus']) {
      const res = await rpc(
        app,
        `/${verb}`,
        {},
        { authorization: `Bearer ${minted.token}` },
      );
      expect(res.statusCode).toBe(403);
    }
    expect((await rpc(app, '/getUpgradeStatus', {}, {})).statusCode).toBe(401);
  });
});
