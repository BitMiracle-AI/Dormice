import { fileURLToPath } from 'node:url';
import {
  ARCHIVE_DEFAULT_SECONDS,
  DEFAULT_LIFECYCLE_POLICY,
} from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { migrateDb, openDb } from './db';
import {
  bumpConfigVersion,
  ensureSettings,
  readConfigVersion,
  readS3Settings,
  readSettings,
  writeSettings,
} from './settings';
import {
  findTemplate,
  listTemplates,
  registerTemplate,
  removeTemplate,
} from './templates';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const TOKEN = 'fleet-token-fleet-token-fleet-token-fleet';
const NOW = new Date('2026-09-14T12:00:00.000Z');

const S3_ENV = {
  DORMICE_S3_ENDPOINT: 'http://127.0.0.1:9000',
  DORMICE_S3_BUCKET: 'seed-bucket',
  DORMICE_S3_ACCESS_KEY_ID: 'seed-key',
  DORMICE_S3_SECRET_ACCESS_KEY: 'seed-secret-never-on-the-wire',
};

function seeded(env: Record<string, string> = {}) {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  // Through loadConfig on purpose: defaults are adjudicated once, in the
  // schema — a hand-written literal here would drift as knobs are added.
  const config = loadConfig({ DORMICE_API_TOKEN: TOKEN, ...env });
  ensureSettings(db, config);
  return { db, config };
}

describe('the settings row', () => {
  it('is seeded from the env at the first start, defaults where the env is silent, at version 1', () => {
    const { db } = seeded({ DORMICE_SANDBOX_DISK_GB: '20' });
    expect(readSettings(db)).toEqual({
      sandboxDefaults: { cpus: 1, memoryGb: 2, diskGb: 20 },
      // No S3 seed, so the seeded default never archives.
      defaultPolicy: { ...DEFAULT_LIFECYCLE_POLICY, archiveAfterSeconds: null },
      s3: null,
      sandboxDomain: null,
      sandboxDomainAliases: [],
      pidsLimit: 4096,
      baseImage: null,
      registryAddress: null,
      updatedAt: null,
    });
    expect(readConfigVersion(db)).toBe(1);
    expect(readS3Settings(db)).toBeNull();
  });

  it('a column born after the row is filled once from the env while empty, counted as a change; a value already there stands', () => {
    // A table seeded before the base image and the registry were knobs.
    const { db, config } = seeded();
    expect(readSettings(db).baseImage).toBeNull();
    ensureSettings(db, {
      ...config,
      DORMICE_BASE_IMAGE: 'dormice-base:20260831',
      DORMICE_REGISTRY_ADDRESS: '10.0.0.5:5000',
    });
    expect(readSettings(db)).toMatchObject({
      baseImage: 'dormice-base:20260831',
      registryAddress: '10.0.0.5:5000',
    });
    // The nodes must hear of it: one version up, for both columns at once.
    expect(readConfigVersion(db)).toBe(2);
    // From here the table wins, as for every other seed.
    ensureSettings(db, {
      ...config,
      DORMICE_BASE_IMAGE: 'dormice-base:20260901',
      DORMICE_REGISTRY_ADDRESS: '10.0.0.6:5000',
    });
    expect(readSettings(db).baseImage).toBe('dormice-base:20260831');
    expect(readSettings(db).registryAddress).toBe('10.0.0.5:5000');
    expect(readConfigVersion(db)).toBe(2);
    // An env with no seed fills nothing and counts nothing.
    const bare = seeded();
    ensureSettings(bare.db, bare.config);
    expect(readConfigVersion(bare.db)).toBe(1);
  });

  it('an S3 seed turns the archive default on and keeps the keys for the bundle, never for the view', () => {
    const { db } = seeded({
      ...S3_ENV,
      DORMICE_SANDBOX_DOMAIN: 'sbx.example.com',
    });
    const view = readSettings(db);
    expect(view.defaultPolicy.archiveAfterSeconds).toBe(
      ARCHIVE_DEFAULT_SECONDS,
    );
    expect(view.s3).toEqual({
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'seed-bucket',
      region: 'us-east-1',
      forcePathStyle: false,
    });
    expect(JSON.stringify(view)).not.toContain('seed-key');
    expect(JSON.stringify(view)).not.toContain('seed-secret');
    expect(readS3Settings(db)).toMatchObject({
      accessKeyId: 'seed-key',
      secretAccessKey: 'seed-secret-never-on-the-wire',
    });
    expect(view.sandboxDomain).toBe('sbx.example.com');
  });

  it('the table wins over a later env edit: the seed is read once', () => {
    const { db, config } = seeded({ DORMICE_SANDBOX_PIDS_LIMIT: '512' });
    expect(readSettings(db).pidsLimit).toBe(512);
    ensureSettings(db, { ...config, DORMICE_SANDBOX_PIDS_LIMIT: 8192 });
    expect(readSettings(db).pidsLimit).toBe(512);
    expect(readConfigVersion(db)).toBe(1);
  });

  it('a write replaces the provided groups whole, leaves the rest, counts the version up and stamps updatedAt', () => {
    const { db } = seeded(S3_ENV);
    const after = writeSettings(
      db,
      {
        pidsLimit: 2048,
        sandboxDomain: 'sbx.example.com',
        sandboxDomainAliases: ['a.example.com'],
      },
      NOW,
    );
    expect(after.pidsLimit).toBe(2048);
    expect(after.sandboxDomain).toBe('sbx.example.com');
    expect(after.sandboxDomainAliases).toEqual(['a.example.com']);
    expect(after.sandboxDefaults).toEqual({ cpus: 1, memoryGb: 2, diskGb: 10 });
    expect(after.s3?.bucket).toBe('seed-bucket');
    expect(after.updatedAt).toBe(NOW.toISOString());
    expect(readConfigVersion(db)).toBe(2);
    expect(
      writeSettings(db, { baseImage: 'dormice-base:20260901' }, NOW).baseImage,
    ).toBe('dormice-base:20260901');
    expect(readConfigVersion(db)).toBe(3);
    // Clearing the store is all six columns at once; the keys go with it.
    writeSettings(
      db,
      { s3: null, defaultPolicy: DEFAULT_LIFECYCLE_POLICY },
      NOW,
    );
    expect(readSettings(db).s3).toBeNull();
    expect(readS3Settings(db)).toBeNull();
    expect(readConfigVersion(db)).toBe(4);
  });

  it('bumpConfigVersion counts up by one and answers the new version', () => {
    const { db } = seeded();
    expect(bumpConfigVersion(db)).toBe(2);
    expect(bumpConfigVersion(db)).toBe(3);
    expect(readConfigVersion(db)).toBe(3);
  });
});

describe('templates', () => {
  it('register is an upsert that counts the version up only when the image changes', () => {
    const { db } = seeded();
    const born = registerTemplate(db, { name: 'py', image: 'img-v1' });
    expect(born.createdAt).toBe(born.updatedAt);
    expect(readConfigVersion(db)).toBe(2);
    // Same image again: nothing written, nothing to tell the nodes.
    expect(registerTemplate(db, { name: 'py', image: 'img-v1' })).toEqual(born);
    expect(readConfigVersion(db)).toBe(2);
    const moved = registerTemplate(db, { name: 'py', image: 'img-v2' });
    expect(moved.image).toBe('img-v2');
    expect(moved.createdAt).toBe(born.createdAt);
    expect(readConfigVersion(db)).toBe(3);
    expect(findTemplate(db, 'py')?.image).toBe('img-v2');
    registerTemplate(db, { name: 'a-first', image: 'x' });
    expect(listTemplates(db).map((t) => t.name)).toEqual(['a-first', 'py']);
  });

  it('remove answers whether a row went, and counts the version up only then', () => {
    const { db } = seeded();
    registerTemplate(db, { name: 'py', image: 'img-v1' });
    expect(readConfigVersion(db)).toBe(2);
    expect(removeTemplate(db, 'py')).toBe(true);
    expect(readConfigVersion(db)).toBe(3);
    expect(removeTemplate(db, 'py')).toBe(false);
    expect(readConfigVersion(db)).toBe(3);
    expect(listTemplates(db)).toEqual([]);
  });
});
