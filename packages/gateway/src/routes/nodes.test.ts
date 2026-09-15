import {
  checkInResponseSchema,
  listNodesResponseSchema,
} from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { readConfigVersion } from '../db/settings';
import { checkInOf, TEST_TOKEN, testGateway } from '../testing';

// The check-in as the pull, and the one per-node knob — over app.inject():
// what a node posts, what it gets back, what listNodes then shows.

const authed = { authorization: `Bearer ${TEST_TOKEN}` };

type App = ReturnType<typeof testGateway>['app'];

function rpc(
  app: App,
  url: string,
  payload: object = {},
  headers: Record<string, string> = authed,
) {
  return app.inject({ method: 'POST', url, headers, payload });
}

const S3_ENV = {
  DORMICE_S3_ENDPOINT: 'http://127.0.0.1:9000',
  DORMICE_S3_BUCKET: 'seed-bucket',
  DORMICE_S3_ACCESS_KEY_ID: 'seed-key',
  DORMICE_S3_SECRET_ACCESS_KEY: 'seed-secret-for-the-nodes-only',
};

async function checkIn(
  app: App,
  id: string,
  over: Parameters<typeof checkInOf>[2] = {},
) {
  const res = await rpc(
    app,
    '/checkIn',
    checkInOf(id, 'http://10.0.0.7:80', over),
  );
  expect(res.statusCode).toBe(200);
  return checkInResponseSchema.parse(res.json());
}

async function nodes(app: App) {
  return listNodesResponseSchema.parse((await rpc(app, '/listNodes')).json())
    .nodes;
}

describe('the check-in as the configuration pull', () => {
  it('a node with no copy gets the whole bundle: settings with the store keys, its swap target, the templates, under the current version', async () => {
    const { app, db } = testGateway({
      ...S3_ENV,
      DORMICE_SANDBOX_DOMAIN: 'sbx.example.com',
      DORMICE_SANDBOX_PIDS_LIMIT: '512',
    });
    await rpc(app, '/registerTemplate', { name: 'py', image: 'img-a' });
    expect(readConfigVersion(db)).toBe(2);

    const answer = await checkIn(app, 'b', { configVersion: null });
    expect(answer.configVersion).toBe(2);
    const config = answer.config;
    if (config === undefined)
      throw new Error('no bundle for a node without a copy');
    expect(config.version).toBe(2);
    expect(config.settings).toEqual({
      sandboxDefaults: { cpus: 1, memoryGb: 2, diskGb: 10 },
      defaultPolicy: expect.objectContaining({ archiveAfterSeconds: 604800 }),
      // Keys included: the node presents them to S3 itself.
      s3: {
        endpoint: 'http://127.0.0.1:9000',
        bucket: 'seed-bucket',
        accessKeyId: 'seed-key',
        secretAccessKey: 'seed-secret-for-the-nodes-only',
        region: 'us-east-1',
        forcePathStyle: false,
      },
      sandboxDomain: 'sbx.example.com',
      sandboxDomainAliases: [],
      pidsLimit: 512,
    });
    expect(config.node).toEqual({ swapGb: 0 });
    expect(config.templates).toMatchObject([{ name: 'py', image: 'img-a' }]);
  });

  it('a node reporting the current version gets the version alone; listNodes shows what each node said it runs', async () => {
    const { app } = testGateway();
    const same = await checkIn(app, 'b', { configVersion: 1 });
    expect(same).toEqual({ configVersion: 1 });
    await checkIn(app, 'c', { configVersion: null });
    const listed = await nodes(app);
    expect(listed.map((n) => [n.id, n.configVersion]).sort()).toEqual([
      ['b', 1],
      ['c', null],
    ]);
  });

  it('every write counts the version up and the next check-in of a node on the old version carries the change', async () => {
    const { app } = testGateway();
    expect(await checkIn(app, 'b', { configVersion: 1 })).toEqual({
      configVersion: 1,
    });
    expect(
      (await rpc(app, '/updateSettings', { pidsLimit: 8192 })).statusCode,
    ).toBe(200);
    const after = await checkIn(app, 'b', { configVersion: 1 });
    expect(after.configVersion).toBe(2);
    expect(after.config?.settings.pidsLimit).toBe(8192);
    // Caught up: nothing rides along anymore.
    expect(await checkIn(app, 'b', { configVersion: 2 })).toEqual({
      configVersion: 2,
    });
    // A version the gateway never issued (a restored gateway database) is
    // still "not mine": the bundle comes.
    expect(
      (await checkIn(app, 'b', { configVersion: 9 })).config,
    ).toBeDefined();
  });

  it('a check-in the row cannot take is answered all the same, bundle included: the write is best-effort, memory is the truth', async () => {
    const { app, db } = testGateway();
    await checkIn(app, 'b', { configVersion: 1 });
    // Every write refused from here — a full disk's shape.
    db.$client.pragma('query_only = 1');
    const answer = await checkIn(app, 'b', { configVersion: null, active: 7 });
    expect(answer.config?.version).toBe(1);
    const listed = (await nodes(app)).find((n) => n.id === 'b');
    expect(listed?.configVersion).toBeNull();
    expect(listed?.reading?.sandboxes.byState.active).toBe(7);
  });
});

describe('updateNodeSettings', () => {
  it('404 for an unknown node, 503 before the node has reported, 400 for a daemon that cannot manage swap', async () => {
    const { app, fleet } = testGateway();
    const unknown = await rpc(app, '/updateNodeSettings', {
      id: 'ghost',
      swapGb: 8,
    });
    expect(unknown.statusCode).toBe(404);

    // A row that never checked in (the import pre-creates one; the shape
    // fleet.ts loads for it): capability unknown.
    fleet.checkIn(checkInOf('b', 'http://10.0.0.7:80'));
    const silent = fleet.get('b');
    if (!silent) throw new Error('no node b');
    silent.reading = null;
    silent.lastCheckInAt = null;
    silent.intervalSeconds = null;
    const early = await rpc(app, '/updateNodeSettings', { id: 'b', swapGb: 8 });
    expect(early.statusCode).toBe(503);
    expect(early.headers['retry-after']).toBe('15');
    expect(early.json().message).toMatch(/has never checked in/);

    fleet.checkIn(checkInOf('b', 'http://10.0.0.7:80', { managedSwap: null }));
    const unable = await rpc(app, '/updateNodeSettings', {
      id: 'b',
      swapGb: 8,
    });
    expect(unable.statusCode).toBe(400);
    expect(unable.json().message).toMatch(/cannot manage swap/);
    expect((await nodes(app)).find((n) => n.id === 'b')?.swapGb).toBe(0);
  });

  it('stores the target on the node row, counts the version up, and the node hears of it at its next check-in — the other node does not', async () => {
    const { app, db } = testGateway();
    await checkIn(app, 'b', { configVersion: 1, managedSwap: { activeGb: 0 } });
    await checkIn(app, 'c', { configVersion: 1 });
    const res = await rpc(app, '/updateNodeSettings', { id: 'b', swapGb: 16 });
    expect(res.statusCode).toBe(200);
    expect(res.json().node).toMatchObject({ id: 'b', swapGb: 16 });
    expect(readConfigVersion(db)).toBe(2);

    const b = await checkIn(app, 'b', { configVersion: 1 });
    expect(b.config?.node).toEqual({ swapGb: 16 });
    const c = await checkIn(app, 'c', { configVersion: 1 });
    expect(c.config?.node).toEqual({ swapGb: 0 });
    // A shrink is stored as written: the node's reconcile is what defers it.
    expect(
      (await rpc(app, '/updateNodeSettings', { id: 'b', swapGb: 0 })).json()
        .node.swapGb,
    ).toBe(0);
    expect(readConfigVersion(db)).toBe(3);
  });
});
