import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIFECYCLE_POLICY,
  getConfigResponseSchema,
  listActivityResponseSchema,
  updateSettingsResponseSchema,
} from '@dormice/shared';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { type MiniS3, startMiniS3 } from '../archive/mini-s3';
import { S3ProbeError } from '../archive/probe';
import type { S3Settings } from '../archive/s3-store';
import { loadConfig } from '../config';
import { migrateDb, openDb } from '../db/db';
import { createSandbox, overwriteState } from '../db/ledger';
import { FakeExecutor } from '../executor/fake';
import { KeyedQueue } from '../keyed-queue';
import type { SwapControl, SwapStatus } from '../swap';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const TOKEN = 'test-token-test-token-test-token';
const authed = { authorization: `Bearer ${TOKEN}` };

/** An env S3 seed — the four core variables, as a spreadable set. */
const S3_ENV = {
  DORMICE_S3_ENDPOINT: 'http://127.0.0.1:9000',
  DORMICE_S3_BUCKET: 'seed-bucket',
  DORMICE_S3_ACCESS_KEY_ID: 'seed-key',
  DORMICE_S3_SECRET_ACCESS_KEY: 'seed-secret-never-on-the-wire',
};

/** The same store as an updateSettings write-shape patch. */
const S3_PATCH = {
  endpoint: 'http://127.0.0.1:9000',
  bucket: 'patched-bucket',
  accessKeyId: 'patch-key',
  secretAccessKey: 'patch-secret-never-on-the-wire',
  region: 'us-east-1',
  forcePathStyle: true,
};

function freshDb() {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  return db;
}

function appOn(
  db: ReturnType<typeof freshDb>,
  env: Record<string, string> = {},
  swap?: SwapControl,
  probeS3: (s3: S3Settings) => Promise<void> = () => Promise.resolve(),
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
    swap,
    // Forged by default: most tests here are about the settings machinery,
    // not S3's availability. Probe-behavior tests inject their own.
    probeS3,
  });
}

/** A ledger of reconcile calls standing in for the real block juggler. */
function fakeSwap(activeGb = 0): SwapControl & { reconciled: number[] } {
  const status = (): Promise<SwapStatus> =>
    Promise.resolve({ activeGb, blocks: [] });
  const control = {
    reconciled: [] as number[],
    status,
    reconcile(targetGb: number) {
      control.reconciled.push(targetGb);
      return status();
    },
  };
  return control;
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

/** Parks an archived row in the ledger — the moving-store guard's trigger. */
function seedArchivedRow(db: ReturnType<typeof freshDb>, name: string) {
  const row = createSandbox(db, {
    id: crypto.randomUUID(),
    name,
    nodeId: 'node-test',
    policy: {
      freezeAfterSeconds: 300,
      stopAfterSeconds: 3600,
      archiveAfterSeconds: 7200,
    },
  });
  overwriteState(db, row.id, 'archived');
  return row;
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
      // No S3 seed in this env, so the seeded default never archives.
      defaultPolicy: { ...DEFAULT_LIFECYCLE_POLICY, archiveAfterSeconds: null },
      // Managed swap has no env seed — it is born from the console.
      swapGb: 0,
      s3: null,
      sandboxDomain: null,
      updatedAt: null,
    });
  });

  it('an env S3 seed lands in the ledger, keys withheld, archive default on', async () => {
    const app = appOn(freshDb(), {
      ...S3_ENV,
      DORMICE_S3_FORCE_PATH_STYLE: 'true',
      DORMICE_SANDBOX_DOMAIN: 'sbx.example.com',
    });
    const res = await rpc(app, '/getConfig');
    const body = getConfigResponseSchema.parse(res.json());
    expect(body.settings.s3).toEqual({
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'seed-bucket',
      region: 'us-east-1',
      forcePathStyle: true,
    });
    expect(body.settings.sandboxDomain).toBe('sbx.example.com');
    expect(body.archive.enabled).toBe(true);
    // The seed's archive adjudication: an S3 seed means a 7-day default.
    expect(body.settings.defaultPolicy.archiveAfterSeconds).toBe(
      7 * 24 * 60 * 60,
    );
    // Neither key ever crosses the wire, in any spelling.
    const raw = res.body;
    expect(raw).not.toContain('seed-secret-never-on-the-wire');
    expect(raw).not.toContain('seed-key');
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

  it('adopts env values once for columns younger than the row, then never again', async () => {
    // First life: a row born before the s3/domain columns existed —
    // simulated by nulling them back out (exactly what the migration
    // leaves on an upgraded daemon's existing row).
    const db = freshDb();
    appOn(db);
    db.run(
      sql`UPDATE runtime_settings SET s3_endpoint = NULL, s3_bucket = NULL, s3_access_key_id = NULL, s3_secret_access_key = NULL, s3_region = NULL, s3_force_path_style = NULL, sandbox_domain = NULL`,
    );

    // The upgraded daemon's first boot: virgin columns adopt the env.
    const upgraded = appOn(db, {
      ...S3_ENV,
      DORMICE_SANDBOX_DOMAIN: 'sbx.example.com',
    });
    const adopted = await settingsOf(upgraded);
    expect(adopted.s3?.bucket).toBe('seed-bucket');
    expect(adopted.sandboxDomain).toBe('sbx.example.com');
    // Adoption never rewrites the standing default policy: this row
    // pre-existed with "never archive", and another group's seed must not
    // change it.
    expect(adopted.defaultPolicy.archiveAfterSeconds).toBeNull();

    // A later boot with a different env: the columns have spoken, the env
    // is done.
    const later = appOn(db, {
      ...S3_ENV,
      DORMICE_S3_BUCKET: 'other-bucket',
      DORMICE_SANDBOX_DOMAIN: 'other.example.com',
    });
    const kept = await settingsOf(later);
    expect(kept.s3?.bucket).toBe('seed-bucket');
    expect(kept.sandboxDomain).toBe('sbx.example.com');
  });

  it('a console clear survives a restart with the env seed still set', async () => {
    const db = freshDb();
    const first = appOn(db, {
      ...S3_ENV,
      DORMICE_SANDBOX_DOMAIN: 'sbx.example.com',
    });
    expect(
      (await rpc(first, '/updateSettings', { s3: null, sandboxDomain: null }))
        .statusCode,
    ).toBe(200);

    // "Restart" with the same env: cleared is a decision, not a virgin
    // column — the env must not resurrect either knob.
    const rebooted = appOn(db, {
      ...S3_ENV,
      DORMICE_SANDBOX_DOMAIN: 'sbx.example.com',
    });
    const settings = await settingsOf(rebooted);
    expect(settings.s3).toBeNull();
    expect(settings.sandboxDomain).toBeNull();
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

  it('refuses an archiving default when no S3 store is configured', async () => {
    const app = appOn(freshDb());
    const res = await rpc(app, '/updateSettings', {
      defaultPolicy: {
        freezeAfterSeconds: 600,
        stopAfterSeconds: 3600,
        archiveAfterSeconds: 7200,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/archiving requires an S3 archive/);
    // But arriving together with the store that honors it is legal.
    const together = await rpc(app, '/updateSettings', {
      s3: S3_PATCH,
      defaultPolicy: {
        freezeAfterSeconds: 600,
        stopAfterSeconds: 3600,
        archiveAfterSeconds: 7200,
      },
    });
    expect(together.statusCode).toBe(200);
    // The reverse combination promises what the same patch takes away.
    const contradictory = await rpc(app, '/updateSettings', {
      s3: null,
      defaultPolicy: {
        freezeAfterSeconds: 600,
        stopAfterSeconds: 3600,
        archiveAfterSeconds: 7200,
      },
    });
    expect(contradictory.statusCode).toBe(400);
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

  it('masks a drifted archive default: the store cleared after it was set', async () => {
    // First life: a store exists (env seed), the operator sets an
    // archiving default — legal, accepted.
    const app = appOn(freshDb(), S3_ENV);
    const set = await rpc(app, '/updateSettings', {
      defaultPolicy: {
        freezeAfterSeconds: 600,
        stopAfterSeconds: 3600,
        archiveAfterSeconds: 7200,
      },
    });
    expect(set.statusCode).toBe(200);

    // The store is cleared (no archived rows — the guard allows it). The
    // stored threshold survives (and would resurface with a new store),
    // but a new acquire must not be promised an archive the daemon cannot
    // perform.
    expect((await rpc(app, '/updateSettings', { s3: null })).statusCode).toBe(
      200,
    );
    const acquired = await rpc(app, '/acquireSandbox', { name: 'drift' });
    expect(acquired.statusCode).toBe(200);
    expect(acquired.json().sandbox.policy.archiveAfterSeconds).toBeNull();
    // The ledger itself still remembers the operator's choice.
    expect((await settingsOf(app)).defaultPolicy.archiveAfterSeconds).toBe(
      7200,
    );
    // And getConfig's adjudication flipped live, no restart involved.
    const body = getConfigResponseSchema.parse(
      (await rpc(app, '/getConfig')).json(),
    );
    expect(body.archive).toEqual({ enabled: false, defaultSeconds: null });
  });

  it('refuses a swap target where the daemon cannot manage swap', async () => {
    // No SwapControl injected — the Mac-dev / fake-executor daemon shape.
    const app = appOn(freshDb());
    const res = await rpc(app, '/updateSettings', { swapGb: 32 });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Linux host with the docker executor/);
    // And getConfig says so up front, so the console never offers the knob.
    const body = getConfigResponseSchema.parse(
      (await rpc(app, '/getConfig')).json(),
    );
    expect(body.swap).toEqual({ supported: false, activeGb: 0 });
  });

  it('saves a swap target and reconciles it immediately', async () => {
    const swap = fakeSwap(32);
    const app = appOn(freshDb(), {}, swap);
    const res = await rpc(app, '/updateSettings', { swapGb: 32 });
    expect(res.statusCode).toBe(200);
    expect(updateSettingsResponseSchema.parse(res.json()).settings.swapGb).toBe(
      32,
    );
    expect(swap.reconciled).toEqual([32]);
    // A patch without swapGb must not re-trigger the block juggler.
    await rpc(app, '/updateSettings', { maxSandboxes: 9 });
    expect(swap.reconciled).toEqual([32]);
    const body = getConfigResponseSchema.parse(
      (await rpc(app, '/getConfig')).json(),
    );
    expect(body.swap).toEqual({ supported: true, activeGb: 32 });
  });

  it('keeps the saved target and answers 500 when applying it fails', async () => {
    // ENOSPC mid-grow: the target must survive (boot and the next edit
    // retry it) and the error must name what happened.
    const swap = fakeSwap();
    swap.reconcile = () => Promise.reject(new Error('fallocate: ENOSPC'));
    const app = appOn(freshDb(), {}, swap);
    const res = await rpc(app, '/updateSettings', { swapGb: 512 });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/target saved.*ENOSPC/);
    expect((await settingsOf(app)).swapGb).toBe(512);
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

describe('updateSettings: the S3 archive store', () => {
  // One real store for the probe's happy path — the store contract suite
  // already pins S3Store against miniS3; here it proves the probe's
  // round trip is the real plumbing, not a stub agreeing with itself.
  let miniS3: MiniS3 | undefined;
  afterAll(async () => {
    await miniS3?.close();
  });

  it('accepts a store that passes the real probe and reports it keyless', async () => {
    miniS3 ??= await startMiniS3();
    const db = freshDb();
    const app = buildApp({
      config: loadConfig({
        DORMICE_DB_PATH: ':memory:',
        DORMICE_NODE_ID: 'node-test',
        DORMICE_API_TOKEN: TOKEN,
      }),
      db,
      executor: new FakeExecutor(),
      locks: new KeyedQueue(),
      logger: false,
      // No probeS3 injected: the route's real probe runs against miniS3.
    });
    const res = await rpc(app, '/updateSettings', {
      s3: {
        endpoint: miniS3.url,
        bucket: 'exam-bucket',
        accessKeyId: 'exam-key',
        secretAccessKey: 'exam-secret-never-on-the-wire',
        region: 'us-east-1',
        forcePathStyle: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const view = updateSettingsResponseSchema.parse(res.json()).settings.s3;
    expect(view).toEqual({
      endpoint: miniS3.url,
      bucket: 'exam-bucket',
      region: 'us-east-1',
      forcePathStyle: true,
    });
    expect(res.body).not.toContain('exam-secret-never-on-the-wire');
    // The probe cleaned up after itself: no probe object left behind.
    expect(miniS3.objects.size).toBe(0);
    // The adjudication flipped live: archiving is now available.
    const body = getConfigResponseSchema.parse(
      (await rpc(app, '/getConfig')).json(),
    );
    expect(body.archive.enabled).toBe(true);
  });

  it('an unreachable store answers 502 and the ledger stays untouched', async () => {
    const db = freshDb();
    const app = buildApp({
      config: loadConfig({
        DORMICE_DB_PATH: ':memory:',
        DORMICE_NODE_ID: 'node-test',
        DORMICE_API_TOKEN: TOKEN,
      }),
      db,
      executor: new FakeExecutor(),
      locks: new KeyedQueue(),
      logger: false,
      // Real probe against a port nothing listens on: connection refused.
    });
    const res = await rpc(app, '/updateSettings', {
      s3: { ...S3_PATCH, endpoint: 'http://127.0.0.1:1' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/nothing was saved/);
    expect((await settingsOf(app)).s3).toBeNull();
  });

  it("an S3-refused probe (4xx) answers 400 with S3's own words", async () => {
    const app = appOn(freshDb(), {}, undefined, () =>
      Promise.reject(new S3ProbeError('AccessDenied: key rejected', 403)),
    );
    const res = await rpc(app, '/updateSettings', { s3: S3_PATCH });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/AccessDenied: key rejected/);
    expect((await settingsOf(app)).s3).toBeNull();
  });

  it('refuses to clear or move the store while sandboxes are archived, by count', async () => {
    const db = freshDb();
    const app = appOn(db, S3_ENV);
    seedArchivedRow(db, 'held-1');
    seedArchivedRow(db, 'held-2');

    const cleared = await rpc(app, '/updateSettings', { s3: null });
    expect(cleared.statusCode).toBe(400);
    expect(cleared.json().message).toMatch(/2 sandboxes are archived/);

    const moved = await rpc(app, '/updateSettings', {
      s3: { ...S3_PATCH, endpoint: S3_ENV.DORMICE_S3_ENDPOINT },
    });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().message).toMatch(/moving it to another/);

    // Same endpoint+bucket, new credentials: nothing moves, allowed.
    const rotated = await rpc(app, '/updateSettings', {
      s3: {
        ...S3_PATCH,
        endpoint: S3_ENV.DORMICE_S3_ENDPOINT,
        bucket: S3_ENV.DORMICE_S3_BUCKET,
      },
    });
    expect(rotated.statusCode).toBe(200);
    expect((await settingsOf(app)).s3?.bucket).toBe('seed-bucket');
  });

  it('enabling from off is allowed even with archived rows — the drift repair path', async () => {
    const db = freshDb();
    const app = appOn(db);
    seedArchivedRow(db, 'stranded');
    const res = await rpc(app, '/updateSettings', { s3: S3_PATCH });
    expect(res.statusCode).toBe(200);
    expect((await settingsOf(app)).s3?.bucket).toBe('patched-bucket');
  });

  it('names the store, never the keys, in the activity ring', async () => {
    const app = appOn(freshDb());
    await rpc(app, '/updateSettings', { s3: S3_PATCH });
    await rpc(app, '/updateSettings', { s3: null });
    const res = await rpc(app, '/listActivity');
    const events = listActivityResponseSchema.parse(res.json()).events;
    expect(events[0]).toMatchObject({
      kind: 'settings-updated',
      detail: 's3=cleared',
    });
    expect(events[1]).toMatchObject({
      kind: 'settings-updated',
      detail: 's3=http://127.0.0.1:9000/patched-bucket',
    });
    expect(res.body).not.toContain('patch-secret-never-on-the-wire');
    expect(res.body).not.toContain('patch-key');
  });
});

describe('updateSettings: the sandbox domain', () => {
  it('sets, reports and clears the domain, with immediate effect on getConfig', async () => {
    const app = appOn(freshDb());
    const set = await rpc(app, '/updateSettings', {
      sandboxDomain: 'sbx.example.com',
    });
    expect(set.statusCode).toBe(200);
    expect(
      updateSettingsResponseSchema.parse(set.json()).settings.sandboxDomain,
    ).toBe('sbx.example.com');
    expect((await settingsOf(app)).sandboxDomain).toBe('sbx.example.com');

    const cleared = await rpc(app, '/updateSettings', { sandboxDomain: null });
    expect(cleared.statusCode).toBe(200);
    expect((await settingsOf(app)).sandboxDomain).toBeNull();

    const events = listActivityResponseSchema.parse(
      (await rpc(app, '/listActivity')).json(),
    ).events;
    expect(events[0]?.detail).toBe('sandboxDomain=cleared');
    expect(events[1]?.detail).toBe('sandboxDomain=sbx.example.com');
  });

  it('refuses anything but a bare hostname', async () => {
    const app = appOn(freshDb());
    for (const bad of [
      'https://sbx.example.com',
      'sbx.example.com:8080',
      '.sbx.example.com',
      'single-label',
    ]) {
      const res = await rpc(app, '/updateSettings', { sandboxDomain: bad });
      expect(res.statusCode, bad).toBe(400);
    }
  });
});
