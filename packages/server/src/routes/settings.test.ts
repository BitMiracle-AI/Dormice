import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIFECYCLE_POLICY,
  getConfigResponseSchema,
  listActivityResponseSchema,
  updateSettingsResponseSchema,
} from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import type { Archiver } from '../archive/archiver';
import { loadConfig } from '../config';
import { migrateDb, openDb } from '../db/db';
import { FakeExecutor } from '../executor/fake';
import { KeyedQueue } from '../keyed-queue';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const TOKEN = 'test-token-test-token-test-token';
const authed = { authorization: `Bearer ${TOKEN}` };

function freshDb() {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  return db;
}

function appOn(
  db: ReturnType<typeof freshDb>,
  env: Record<string, string> = {},
  archiver?: Archiver,
) {
  const config = loadConfig({
    DORMICE_DB_PATH: ':memory:',
    DORMICE_NODE_ID: 'node-test',
    DORMICE_API_TOKEN: TOKEN,
    ...env,
  });
  return buildApp({
    config,
    db,
    executor: new FakeExecutor(),
    locks: new KeyedQueue(),
    logger: false,
    archiver,
  });
}

type App = ReturnType<typeof appOn>;

function rpc(
  app: App,
  url: string,
  payload: Record<string, unknown> = {},
  headers: Record<string, string> = authed,
) {
  return app.inject({ method: 'POST', url, headers, payload });
}

async function settingsOf(app: App) {
  const res = await rpc(app, '/getConfig');
  expect(res.statusCode).toBe(200);
  return getConfigResponseSchema.parse(res.json()).settings;
}

describe('runtime settings: seeding', () => {
  it('seeds from the env at first boot, defaults where the env is silent', async () => {
    const app = appOn(freshDb(), {
      DORMICE_MAX_SANDBOXES: '7',
      DORMICE_SANDBOX_DISK_GB: '20',
    });
    expect(await settingsOf(app)).toEqual({
      maxSandboxes: 7,
      sandboxDefaults: { cpus: 1, memoryGb: 2, diskGb: 20 },
      // No archiver in this app, so the seeded default never archives.
      defaultPolicy: { ...DEFAULT_LIFECYCLE_POLICY, archiveAfterSeconds: null },
      updatedAt: null,
    });
  });

  it('the ledger wins over a later env edit — seeds are read once', async () => {
    const db = freshDb();
    appOn(db, { DORMICE_MAX_SANDBOXES: '5' });
    // Same ledger, "restarted" with a different env: the row already
    // exists, so the new env value is deliberately ignored...
    const rebooted = appOn(db, { DORMICE_MAX_SANDBOXES: '9' });
    expect((await settingsOf(rebooted)).maxSandboxes).toBe(5);
    // ...while getConfig still reports what the env says, as an entry.
    const body = getConfigResponseSchema.parse(
      (await rpc(rebooted, '/getConfig')).json(),
    );
    expect(
      body.entries.find((e) => e.key === 'DORMICE_MAX_SANDBOXES')?.value,
    ).toBe('9');
  });
});

describe('updateSettings', () => {
  it('raises maxSandboxes with immediate effect on the acquire gate', async () => {
    const app = appOn(freshDb(), { DORMICE_MAX_SANDBOXES: '1' });
    expect((await rpc(app, '/acquireSandbox', { name: 'a' })).statusCode).toBe(
      200,
    );
    expect((await rpc(app, '/acquireSandbox', { name: 'b' })).statusCode).toBe(
      429,
    );

    const res = await rpc(app, '/updateSettings', { maxSandboxes: 2 });
    expect(res.statusCode).toBe(200);
    expect(
      updateSettingsResponseSchema.parse(res.json()).settings.maxSandboxes,
    ).toBe(2);

    // No restart, no re-read of the env: the very next create passes.
    expect((await rpc(app, '/acquireSandbox', { name: 'b' })).statusCode).toBe(
      200,
    );
    // And the observation window reports the new capacity.
    const host = await rpc(app, '/getHostMetrics');
    expect(host.json().sandboxes.maxSandboxes).toBe(2);
  });

  it('a new default policy applies to the next acquire, not existing sandboxes', async () => {
    const app = appOn(freshDb());
    const before = await rpc(app, '/acquireSandbox', { name: 'old' });
    expect(before.json().sandbox.policy.freezeAfterSeconds).toBe(
      DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
    );

    await rpc(app, '/updateSettings', {
      defaultPolicy: {
        freezeAfterSeconds: 42,
        stopAfterSeconds: null,
        archiveAfterSeconds: null,
      },
    });

    const created = await rpc(app, '/acquireSandbox', { name: 'new' });
    expect(created.json().sandbox.policy).toMatchObject({
      freezeAfterSeconds: 42,
      stopAfterSeconds: null,
    });
    // Existing sandboxes keep the policy they were born with.
    const woken = await rpc(app, '/acquireSandbox', { name: 'old' });
    expect(woken.json().sandbox.policy.freezeAfterSeconds).toBe(
      DEFAULT_LIFECYCLE_POLICY.freezeAfterSeconds,
    );
  });

  it('replaces provided groups whole and leaves the rest untouched', async () => {
    const app = appOn(freshDb(), { DORMICE_SANDBOX_MEMORY_GB: '4' });
    await rpc(app, '/updateSettings', { maxSandboxes: 50 });
    const settings = await settingsOf(app);
    expect(settings.maxSandboxes).toBe(50);
    expect(settings.sandboxDefaults.memoryGb).toBe(4);
    expect(settings.updatedAt).not.toBeNull();
  });

  it('refuses an archiving default when the daemon has no archiver', async () => {
    const app = appOn(freshDb());
    const res = await rpc(app, '/updateSettings', {
      defaultPolicy: {
        freezeAfterSeconds: 600,
        stopAfterSeconds: 3600,
        archiveAfterSeconds: 7200,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/archiving requires S3/);
  });

  it('refuses an empty patch and a disordered default policy', async () => {
    const app = appOn(freshDb());
    expect((await rpc(app, '/updateSettings', {})).statusCode).toBe(400);
    const disordered = await rpc(app, '/updateSettings', {
      defaultPolicy: {
        freezeAfterSeconds: 100,
        stopAfterSeconds: 50,
        archiveAfterSeconds: null,
      },
    });
    expect(disordered.statusCode).toBe(400);
  });

  it('masks a drifted archive default: archiver removed after it was set', async () => {
    // First life: an archiver exists, the operator sets an archiving
    // default — legal, accepted.
    const db = freshDb();
    // A hollow archiver: nothing in this test archives, its presence is
    // what flips the boot's adjudication.
    const withArchiver = appOn(db, {}, {} as unknown as Archiver);
    const set = await rpc(withArchiver, '/updateSettings', {
      defaultPolicy: {
        freezeAfterSeconds: 600,
        stopAfterSeconds: 3600,
        archiveAfterSeconds: 7200,
      },
    });
    expect(set.statusCode).toBe(200);

    // Second life: same ledger, S3 removed from the env. The stored
    // threshold survives (and would resurface with S3), but a new acquire
    // must not be promised an archive the daemon cannot perform.
    const withoutArchiver = appOn(db);
    const acquired = await rpc(withoutArchiver, '/acquireSandbox', {
      name: 'drift',
    });
    expect(acquired.statusCode).toBe(200);
    expect(acquired.json().sandbox.policy.archiveAfterSeconds).toBeNull();
    // The ledger itself still remembers the operator's choice.
    expect(
      (await settingsOf(withoutArchiver)).defaultPolicy.archiveAfterSeconds,
    ).toBe(7200);
  });

  it('records the change in the activity ring with its actor', async () => {
    const app = appOn(freshDb());
    await rpc(app, '/updateSettings', { maxSandboxes: 3 });
    const events = listActivityResponseSchema.parse(
      (await rpc(app, '/listActivity')).json(),
    ).events;
    expect(events[0]).toMatchObject({
      kind: 'settings-updated',
      actor: 'env-token',
      detail: 'maxSandboxes=3',
    });
  });

  it('is admin-only: an API key gets an honest 403', async () => {
    const app = appOn(freshDb());
    const minted = await rpc(app, '/createApiKey', { name: 'robot' });
    expect(minted.statusCode).toBe(200);
    const keyToken = minted.json().token as string;

    const refused = await rpc(
      app,
      '/updateSettings',
      { maxSandboxes: 999 },
      { authorization: `Bearer ${keyToken}` },
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toMatch(
      /cannot manage API keys or settings/,
    );
    // And the key still opens normal doors — it is the verb that refused.
    expect(
      (
        await rpc(
          app,
          '/listSandboxes',
          {},
          { authorization: `Bearer ${keyToken}` },
        )
      ).statusCode,
    ).toBe(200);
  });
});
