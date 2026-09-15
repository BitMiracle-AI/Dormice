import {
  ARCHIVE_DEFAULT_SECONDS,
  DEFAULT_LIFECYCLE_POLICY,
  getConfigResponseSchema,
  updateSettingsResponseSchema,
} from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS } from '../config';
import { readConfigVersion } from '../db/settings';
import { S3ProbeError } from '../probe';
import { checkInOf, TEST_TOKEN, testGateway } from '../testing';

type Harness = ReturnType<typeof testGateway>;
type App = Harness['app'];

const authed = { authorization: `Bearer ${TEST_TOKEN}` };

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

/** A node the fleet knows, with the census its last check-in reported; one address per id. */
function reporting(
  h: Harness,
  id: string,
  over: Parameters<typeof checkInOf>[2] = {},
) {
  const host =
    1 + ([...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 250);
  const outcome = h.fleet.checkIn(
    checkInOf(id, `http://10.0.0.${host}:80`, over),
  );
  if ('refused' in outcome) throw new Error(outcome.refused);
  return outcome.node;
}

describe('getConfig on the gateway', () => {
  it('reports every gateway knob with value and source, and the settings in force', async () => {
    const { app } = testGateway({ DORMICE_SANDBOX_DISK_GB: '7' });
    const res = await rpc(app, '/getConfig');
    expect(res.statusCode).toBe(200);
    const body = getConfigResponseSchema.parse(res.json());
    const byKey = new Map(body.entries.map((e) => [e.key, e]));
    // Complete: one entry per knob the gateway's config schema knows.
    expect(body.entries).toHaveLength(Object.keys(CONFIG_KEYS).length);
    expect(byKey.get('DORMICE_SANDBOX_DISK_GB')).toMatchObject({
      value: '7',
      source: 'env',
    });
    expect(byKey.get('DORMICE_GATEWAY_PORT')).toMatchObject({
      value: '3677',
      source: 'default',
    });
    // Optional and unset: honestly null, not invented.
    expect(byKey.get('DORMICE_SANDBOX_DOMAIN')).toMatchObject({ value: null });
    expect(body.settings.sandboxDefaults.diskGb).toBe(7);
    expect(body.archive).toEqual({ enabled: false, defaultSeconds: null });
  });

  it('withholds secrets, reporting only their presence', async () => {
    const { app } = testGateway(S3_ENV);
    const body = getConfigResponseSchema.parse(
      (await rpc(app, '/getConfig')).json(),
    );
    const token = body.entries.find((e) => e.key === 'DORMICE_API_TOKEN');
    expect(token).toMatchObject({ value: null, redacted: true });
    const key = body.entries.find((e) => e.key === 'DORMICE_S3_ACCESS_KEY_ID');
    expect(key).toMatchObject({ value: null, redacted: true });
    // The raw secrets appear nowhere in the whole response.
    const text = JSON.stringify(body);
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).not.toContain('seed-key');
    expect(text).not.toContain('seed-secret');
    // An S3 seed turns archiving on with the one-week default.
    expect(body.archive).toEqual({
      enabled: true,
      defaultSeconds: ARCHIVE_DEFAULT_SECONDS,
    });
  });

  it('is admin-only: a minted key reads 403, the console session reads it', async () => {
    const { app } = testGateway();
    const minted = await rpc(app, '/createApiKey', { name: 'robot' });
    const keyToken = minted.json().token as string;
    const refused = await rpc(
      app,
      '/getConfig',
      {},
      { authorization: `Bearer ${keyToken}` },
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toMatch(/cannot manage API keys/);
  });
});

describe('updateSettings on the gateway', () => {
  it('sets the pids cap live, floors it, and never accepts unlimited; every write counts the version up', async () => {
    const { app, db } = testGateway();
    expect((await settingsOf(app)).pidsLimit).toBe(4096);
    expect(readConfigVersion(db)).toBe(1);

    const raised = await rpc(app, '/updateSettings', { pidsLimit: 8192 });
    expect(raised.statusCode).toBe(200);
    expect(
      updateSettingsResponseSchema.parse(raised.json()).settings.pidsLimit,
    ).toBe(8192);
    expect((await settingsOf(app)).pidsLimit).toBe(8192);
    expect(readConfigVersion(db)).toBe(2);

    const tooLow = await rpc(app, '/updateSettings', { pidsLimit: 255 });
    expect(tooLow.statusCode).toBe(400);
    expect(tooLow.json().message).toMatch(/pidsLimit.*at least 256/);
    expect((await settingsOf(app)).pidsLimit).toBe(8192);
    // A refused write is not a change the nodes must hear about.
    expect(readConfigVersion(db)).toBe(2);
    expect(
      (await rpc(app, '/updateSettings', { pidsLimit: 256 })).statusCode,
    ).toBe(200);
    expect(
      (await rpc(app, '/updateSettings', { pidsLimit: 0 })).statusCode,
    ).toBe(400);
  });

  it('replaces provided groups whole and leaves the rest untouched', async () => {
    const { app } = testGateway({ DORMICE_SANDBOX_MEMORY_GB: '4' });
    await rpc(app, '/updateSettings', { pidsLimit: 512 });
    const settings = await settingsOf(app);
    expect(settings.pidsLimit).toBe(512);
    expect(settings.sandboxDefaults.memoryGb).toBe(4);
    expect(settings.updatedAt).not.toBeNull();
  });

  it('an empty patch is a caller confusion, 400', async () => {
    const { app } = testGateway();
    expect((await rpc(app, '/updateSettings', {})).statusCode).toBe(400);
  });

  it('re-points the base image, seeded from the env and carried to the nodes in the bundle; the registry is read-only over the wire', async () => {
    const { app, db } = testGateway({
      DORMICE_BASE_IMAGE: 'dormice-base:20260831',
      DORMICE_REGISTRY_ADDRESS: '10.0.0.5:5000',
    });
    expect(await settingsOf(app)).toMatchObject({
      baseImage: 'dormice-base:20260831',
      registryAddress: '10.0.0.5:5000',
    });
    const res = await rpc(app, '/updateSettings', {
      baseImage: 'dormice-base:20260901',
    });
    expect(res.statusCode).toBe(200);
    expect(
      updateSettingsResponseSchema.parse(res.json()).settings.baseImage,
    ).toBe('dormice-base:20260901');
    expect(readConfigVersion(db)).toBe(2);
    const bundle = await rpc(
      app,
      '/checkIn',
      checkInOf('b', 'http://10.0.0.7:80', { configVersion: 1 }),
    );
    expect(bundle.json().config.settings).toMatchObject({
      baseImage: 'dormice-base:20260901',
      registryAddress: '10.0.0.5:5000',
    });
    // Not a reference: refused at the door, the table stands.
    expect(
      (await rpc(app, '/updateSettings', { baseImage: 'two words' }))
        .statusCode,
    ).toBe(400);
    // The registry is not a wire knob in this cut: an unknown key is
    // stripped, and a patch of it alone is the empty patch.
    expect(
      (await rpc(app, '/updateSettings', { registryAddress: '1.2.3.4:5000' }))
        .statusCode,
    ).toBe(400);
    expect((await settingsOf(app)).registryAddress).toBe('10.0.0.5:5000');
  });

  it('a new default policy is stored for the nodes to hand to their next acquire', async () => {
    const { app } = testGateway();
    const res = await rpc(app, '/updateSettings', {
      defaultPolicy: {
        freezeAfterSeconds: 42,
        stopAfterSeconds: null,
        archiveAfterSeconds: null,
      },
    });
    expect(res.statusCode).toBe(200);
    expect((await settingsOf(app)).defaultPolicy).toEqual({
      freezeAfterSeconds: 42,
      stopAfterSeconds: null,
      archiveAfterSeconds: null,
    });
  });

  it('refuses an archiving default when no S3 store is configured, judged after the patch', async () => {
    const { app } = testGateway();
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
    // And { s3: null, archiving default } in one patch is refused.
    const contradiction = await rpc(app, '/updateSettings', {
      s3: null,
      defaultPolicy: {
        freezeAfterSeconds: 600,
        stopAfterSeconds: 3600,
        archiveAfterSeconds: 7200,
      },
    });
    expect(contradiction.statusCode).toBe(400);
  });

  it('is admin-only: a minted key gets an honest 403 and the settings stand', async () => {
    const { app } = testGateway();
    const minted = await rpc(app, '/createApiKey', { name: 'robot' });
    expect(minted.statusCode).toBe(200);
    const keyToken = minted.json().token as string;
    const refused = await rpc(
      app,
      '/updateSettings',
      { pidsLimit: 999 },
      { authorization: `Bearer ${keyToken}` },
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toMatch(/cannot manage API keys/);
    expect((await settingsOf(app)).pidsLimit).toBe(4096);
  });
});

describe('updateSettings: the S3 archive store', () => {
  it('a passing probe writes the store and answers the view shape, keys never echoed', async () => {
    const probed: string[] = [];
    const { app } = testGateway(
      {},
      {
        probeS3: async (s3) => {
          probed.push(s3.bucket);
        },
      },
    );
    const res = await rpc(app, '/updateSettings', { s3: S3_PATCH });
    expect(res.statusCode).toBe(200);
    expect(probed).toEqual(['patched-bucket']);
    expect(updateSettingsResponseSchema.parse(res.json()).settings.s3).toEqual({
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'patched-bucket',
      region: 'us-east-1',
      forcePathStyle: true,
    });
    expect(res.body).not.toContain('patch-secret-never-on-the-wire');
    expect(res.body).not.toContain('patch-key');
    // The adjudication flipped live: archiving is now available.
    const body = getConfigResponseSchema.parse(
      (await rpc(app, '/getConfig')).json(),
    );
    expect(body.archive.enabled).toBe(true);
  });

  it('an unreachable store answers 502 and the table stays untouched', async () => {
    const { app } = testGateway(
      {},
      {
        probeS3: () => Promise.reject(new Error('connect ECONNREFUSED')),
      },
    );
    const res = await rpc(app, '/updateSettings', { s3: S3_PATCH });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/nothing was saved/);
    expect((await settingsOf(app)).s3).toBeNull();
  });

  it("an S3-refused probe (4xx) answers 400 with S3's own words", async () => {
    const { app } = testGateway(
      {},
      {
        probeS3: () =>
          Promise.reject(new S3ProbeError('AccessDenied: key rejected', 403)),
      },
    );
    const res = await rpc(app, '/updateSettings', { s3: S3_PATCH });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/AccessDenied: key rejected/);
    expect((await settingsOf(app)).s3).toBeNull();
  });

  it('refuses to clear or move the store while any node reports sandboxes archived in it, by fleet count', async () => {
    const h = testGateway(S3_ENV);
    reporting(h, 'b', { archived: 2 });
    reporting(h, 'c', { restoring: 1 });

    const cleared = await rpc(h.app, '/updateSettings', { s3: null });
    expect(cleared.statusCode).toBe(400);
    expect(cleared.json().message).toMatch(/3 sandboxes are archived/);
    expect(cleared.json().message).toMatch(/across the fleet/);

    const moved = await rpc(h.app, '/updateSettings', {
      s3: { ...S3_PATCH, endpoint: S3_ENV.DORMICE_S3_ENDPOINT },
    });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().message).toMatch(/moving it to another/);

    // Same endpoint+bucket, new credentials: nothing moves, allowed.
    const rotated = await rpc(h.app, '/updateSettings', {
      s3: {
        ...S3_PATCH,
        endpoint: S3_ENV.DORMICE_S3_ENDPOINT,
        bucket: S3_ENV.DORMICE_S3_BUCKET,
      },
    });
    expect(rotated.statusCode).toBe(200);
    expect((await settingsOf(h.app)).s3?.bucket).toBe('seed-bucket');
  });

  it('a node that has never reported makes the count unknown: 503 with Retry-After, not a guess', async () => {
    const h = testGateway(S3_ENV);
    reporting(h, 'b', { archived: 0 });
    // A row the import pre-created, before the node's first check-in (the
    // shape fleet.ts loads for it): its disks cannot be counted.
    const silent = reporting(h, 'c');
    silent.reading = null;
    silent.lastCheckInAt = null;
    silent.intervalSeconds = null;
    const res = await rpc(h.app, '/updateSettings', { s3: null });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('15');
    expect(res.json().message).toMatch(/node c has never checked in/);
    expect((await settingsOf(h.app)).s3?.bucket).toBe('seed-bucket');
    // Once it has reported (nothing archived there), the clear goes through.
    reporting(h, 'c');
    expect((await rpc(h.app, '/updateSettings', { s3: null })).statusCode).toBe(
      200,
    );
    expect((await settingsOf(h.app)).s3).toBeNull();
  });

  it('enabling from off is allowed even with archived rows reported — the drift repair path', async () => {
    const h = testGateway();
    reporting(h, 'b', { archived: 5 });
    const res = await rpc(h.app, '/updateSettings', { s3: S3_PATCH });
    expect(res.statusCode).toBe(200);
    expect((await settingsOf(h.app)).s3?.bucket).toBe('patched-bucket');
  });

  it('with no node at all the count is zero and the store may be cleared', async () => {
    const { app } = testGateway(S3_ENV);
    expect((await rpc(app, '/updateSettings', { s3: null })).statusCode).toBe(
      200,
    );
  });
});

describe('updateSettings: the sandbox domain', () => {
  it('sets, reports and clears the domain, with immediate effect on getConfig', async () => {
    const { app } = testGateway();
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
  });

  it('refuses anything but a bare hostname', async () => {
    const { app } = testGateway();
    for (const bad of [
      'https://sbx.example.com',
      'sbx.example.com:8080',
      '.sbx.example.com',
      'single-label',
    ]) {
      const res = await rpc(app, '/updateSettings', { sandboxDomain: bad });
      expect(res.statusCode, bad).toBe(400);
      const alias = await rpc(app, '/updateSettings', {
        sandboxDomain: 'sbx.example.com',
        sandboxDomainAliases: [bad],
      });
      expect(alias.statusCode, bad).toBe(400);
    }
  });

  it('sets, reports and clears aliases', async () => {
    const { app } = testGateway({ DORMICE_SANDBOX_DOMAIN: 'sbx.example.com' });
    const set = await rpc(app, '/updateSettings', {
      sandboxDomainAliases: ['a.example.com', 'b.example.com'],
    });
    expect(set.statusCode).toBe(200);
    expect((await settingsOf(app)).sandboxDomainAliases).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
    const cleared = await rpc(app, '/updateSettings', {
      sandboxDomainAliases: [],
    });
    expect(cleared.statusCode).toBe(200);
    expect((await settingsOf(app)).sandboxDomainAliases).toEqual([]);
  });

  it('refuses alias lists that contradict the post-patch state, honestly', async () => {
    const { app } = testGateway({ DORMICE_SANDBOX_DOMAIN: 'sbx.example.com' });

    const dup = await rpc(app, '/updateSettings', {
      sandboxDomainAliases: ['a.example.com', 'A.example.com'],
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().message).toContain('more than once');

    const overlap = await rpc(app, '/updateSettings', {
      sandboxDomainAliases: ['SBX.example.com'],
    });
    expect(overlap.statusCode).toBe(400);
    expect(overlap.json().message).toContain('already the sandbox domain');

    const orphanApp = testGateway().app;
    const orphan = await rpc(orphanApp, '/updateSettings', {
      sandboxDomainAliases: ['a.example.com'],
    });
    expect(orphan.statusCode).toBe(400);
    expect(orphan.json().message).toContain('set sandboxDomain first');

    expect(
      (
        await rpc(app, '/updateSettings', {
          sandboxDomainAliases: ['a.example.com'],
        })
      ).statusCode,
    ).toBe(200);
    const dangling = await rpc(app, '/updateSettings', { sandboxDomain: null });
    expect(dangling.statusCode).toBe(400);
    expect(dangling.json().message).toContain('sandboxDomainAliases');

    // The atomic swap, expressed whole, passes...
    const swap = await rpc(app, '/updateSettings', {
      sandboxDomain: 'a.example.com',
      sandboxDomainAliases: ['sbx.example.com'],
    });
    expect(swap.statusCode).toBe(200);
    const swapped = updateSettingsResponseSchema.parse(swap.json()).settings;
    expect(swapped.sandboxDomain).toBe('a.example.com');
    expect(swapped.sandboxDomainAliases).toEqual(['sbx.example.com']);
    // ...and the full clear.
    const clear = await rpc(app, '/updateSettings', {
      sandboxDomain: null,
      sandboxDomainAliases: [],
    });
    expect(clear.statusCode).toBe(200);
  });
});

describe('the default policy seed', () => {
  it('follows the shared default with archiving off, and the one-week default with a store', async () => {
    expect((await settingsOf(testGateway().app)).defaultPolicy).toEqual({
      ...DEFAULT_LIFECYCLE_POLICY,
      archiveAfterSeconds: null,
    });
    expect(
      (await settingsOf(testGateway(S3_ENV).app)).defaultPolicy
        .archiveAfterSeconds,
    ).toBe(ARCHIVE_DEFAULT_SECONDS);
  });
});
