import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  migrateDb as migrateNodeDb,
  openDb as openNodeDb,
} from '@dormice/server';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { getConsoleAccount } from './db/account';
import { listApiKeys } from './db/api-keys';
import { migrateDb, openDb } from './db/db';
import { fleetStateSamples, nodes } from './db/schema';
import { readConfigVersion, readS3Settings, readSettings } from './db/settings';
import { listTemplates } from './db/templates';
import { Fleet } from './fleet';
import { importNodeLedger, parseEnvFile } from './import-ledger';

// The one-time import against a real node ledger: the daemon's own
// migrations build it (through @dormice/server), plain SQL fills it the
// way months of a single machine did — a pre-move settings row with the
// old spellings of "off", templates, keys with a revoked one, a console
// account, a fleet history straddling the thirty-day cut.

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const NODE_MIGRATIONS = fileURLToPath(
  new URL('../../server/drizzle', import.meta.url),
);
const TOKEN = 'fleet-token-fleet-token-fleet-token-fleet';
const NOW = new Date('2026-09-15T12:00:00.000Z');

function gatewayDb(env: Record<string, string> = {}) {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const config = loadConfig({
    DORMICE_API_TOKEN: TOKEN,
    DORMICE_GATEWAY_DB_PATH: '/var/lib/dormice-gateway/gateway.db',
    ...env,
  });
  return { db, config };
}

/**
 * The daemon's migrations up to and including `lastTag`, as a migrations
 * folder of their own: the import reads the ledger the PREVIOUS build
 * left, which still holds the tables this build's migration 0027 drops —
 * a ledger built with every migration would have nothing to import.
 */
function nodeMigrationsUpTo(lastTag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dormice-node-migrations-'));
  mkdirSync(path.join(dir, 'meta'));
  const journal = JSON.parse(
    readFileSync(path.join(NODE_MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string }> };
  const cut = journal.entries.findIndex((e) => e.tag === lastTag);
  if (cut === -1) throw new Error(`no node migration tagged ${lastTag}`);
  const entries = journal.entries.slice(0, cut + 1);
  writeFileSync(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    copyFileSync(
      path.join(NODE_MIGRATIONS, `${entry.tag}.sql`),
      path.join(dir, `${entry.tag}.sql`),
    );
  }
  return dir;
}

/** The last daemon migration before the fourth cut dropped the moved tables. */
const PRE_DROP_MIGRATIONS = nodeMigrationsUpTo('0026_fleet-base-image');

/** A node's ledger on disk, at the previous build's schema, with the daemon's tables filled by SQL. */
function nodeLedger(fill: (raw: Database.Database) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dormice-import-'));
  const file = path.join(dir, 'dormice.db');
  const db = openNodeDb(file);
  migrateNodeDb(db, PRE_DROP_MIGRATIONS);
  fill(db.$client);
  db.$client.close();
  return file;
}

const iso = (offsetDays: number) =>
  new Date(NOW.getTime() - offsetDays * 86_400_000).toISOString();

/** The machine's settings as the daemon left them before the move: two-state columns spelled the old way. */
function fillProduction(raw: Database.Database) {
  raw
    .prepare(
      `INSERT INTO runtime_settings (id, sandbox_cpus, sandbox_memory_gb, sandbox_disk_gb,
        default_freeze_after_seconds, default_stop_after_seconds, default_archive_after_seconds,
        swap_gb, s3_endpoint, s3_bucket, s3_access_key_id, s3_secret_access_key, s3_region,
        s3_force_path_style, sandbox_domain, sandbox_domain_aliases, pids_limit, updated_at)
       VALUES (1, 2, 4, 20, 300, NULL, 604800, 8,
        'https://oss.example.com', 'prod-bucket', 'AKIA-not-real', 'secret-not-real', 'cn-beijing', 0,
        '', NULL, 4096, '2026-08-19T10:00:00.000Z')`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO templates (name, image, created_at, updated_at) VALUES
       ('clawsgo_20260808_base', 'clawsgo_20260808_base:20260907', '2026-08-08T00:00:00.000Z', '2026-09-07T00:00:00.000Z'),
       ('rarvis', 'rarvis_20260808_base:20260901', '2026-08-08T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO api_keys (id, name, key_hash, prefix, created_at, last_used_at, expires_at, disabled_at, revoked_at) VALUES
       ('k1', 'clawsgo', 'h1', 'aaaaaaaa', '2026-07-19T00:00:00.000Z', '2026-09-15T00:00:00.000Z', NULL, NULL, NULL),
       ('k2', 'ci', 'h2', 'bbbbbbbb', '2026-07-20T00:00:00.000Z', NULL, '2026-12-31T23:59:59.999Z', NULL, NULL),
       ('k3', 'old', 'h3', 'cccccccc', '2026-07-01T00:00:00.000Z', NULL, NULL, NULL, '2026-07-19T00:00:00.000Z')`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO console_account (id, username, password_hash, session_secret, created_at, updated_at)
       VALUES (1, 'admin', 'scrypt$16384$8$1$salt$hash', 'session-secret-not-real', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z')`,
    )
    .run();
  const sample = raw.prepare(
    `INSERT INTO fleet_snapshots (at, active, frozen, stopped, archived, restoring, total)
     VALUES (?, ?, 0, 0, 0, 0, ?)`,
  );
  // 35 rows inside the thirty days, 5 older.
  for (let i = 0; i < 40; i += 1) {
    const daysAgo = i < 35 ? i * 0.5 : 31 + (i - 35);
    sample.run(iso(daysAgo), 10 + i, 10 + i);
  }
}

const NODE_ENV = parseEnvFile(`
# written by install.sh
DORMICE_EXECUTOR=docker
DORMICE_API_TOKEN="${TOKEN}"
DORMICE_BASE_IMAGE=dormice-base:20260718
# moved to /etc/dormice/gateway.env (2026-09-14): DORMICE_SANDBOX_DOMAIN=sandbox.example.com
DORMICE_DATA_DIR=/var/lib/dormice
`);

describe('parseEnvFile', () => {
  it('reads KEY=VALUE, skips blanks and comments, strips one pair of quotes', () => {
    expect(NODE_ENV).toEqual({
      DORMICE_EXECUTOR: 'docker',
      DORMICE_API_TOKEN: TOKEN,
      DORMICE_BASE_IMAGE: 'dormice-base:20260718',
      DORMICE_DATA_DIR: '/var/lib/dormice',
    });
    expect(parseEnvFile("A='x=y'\nB=\nC")).toEqual({ A: 'x=y', B: '' });
  });
});

describe('importNodeLedger', () => {
  it("carries a single machine's settings into the gateway's row, translating the old spellings; pre-creates the node row with its swap target; copies templates, keys, the account and thirty days of history — and counts, never values", () => {
    const ledger = nodeLedger(fillProduction);
    const { db, config } = gatewayDb({
      DORMICE_REGISTRY_ADDRESS: '10.0.0.5:5000',
    });
    const outcome = importNodeLedger(db, config, {
      nodeDbPath: ledger,
      nodeEnv: NODE_ENV,
      now: NOW,
    });
    expect(outcome).toEqual({
      code: 0,
      counts: {
        settings: 1,
        nodes: 1,
        templates: 2,
        apiKeys: 3,
        consoleAccount: 1,
        fleetStateSamples: 35,
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('secret-not-real');

    expect(readSettings(db)).toEqual({
      sandboxDefaults: { cpus: 2, memoryGb: 4, diskGb: 20 },
      defaultPolicy: {
        freezeAfterSeconds: 300,
        stopAfterSeconds: null,
        archiveAfterSeconds: 604800,
      },
      s3: {
        endpoint: 'https://oss.example.com',
        bucket: 'prod-bucket',
        region: 'cn-beijing',
        forcePathStyle: false,
      },
      // '' was the pre-move "off"; NULL aliases were "none".
      sandboxDomain: null,
      sandboxDomainAliases: [],
      pidsLimit: 4096,
      // The node's env, the base image's old home; the registry is the seed's.
      baseImage: 'dormice-base:20260718',
      registryAddress: '10.0.0.5:5000',
      // The operator's edits carried: not the seed.
      updatedAt: '2026-08-19T10:00:00.000Z',
    });
    expect(readS3Settings(db)).toMatchObject({
      accessKeyId: 'AKIA-not-real',
      secretAccessKey: 'secret-not-real',
    });
    expect(readConfigVersion(db)).toBe(1);

    // The node's row, never checked in, with the target its daemon will
    // reconcile its swap to at the first check-in; a fleet built on it
    // loads it as a node that has never checked in.
    expect(db.select().from(nodes).all()).toMatchObject([
      {
        id: 'node-1',
        endpoint: 'http://127.0.0.1:3676',
        swapGb: 8,
        lastCheckInAt: null,
        reading: null,
      },
    ]);
    const node = new Fleet(db).get('node-1');
    expect(node?.swapGb).toBe(8);
    expect(node?.lastCheckInAt).toBeNull();

    expect(listTemplates(db).map((t) => [t.name, t.image])).toEqual([
      ['clawsgo_20260808_base', 'clawsgo_20260808_base:20260907'],
      ['rarvis', 'rarvis_20260808_base:20260901'],
    ]);
    const keys = listApiKeys(db);
    expect(keys.map((k) => [k.name, k.revokedAt !== null]).sort()).toEqual([
      ['ci', false],
      ['clawsgo', false],
      ['old', true],
    ]);
    expect(keys.find((k) => k.name === 'ci')?.expiresAt).toBe(
      '2026-12-31T23:59:59.999Z',
    );
    expect(getConsoleAccount(db)).toMatchObject({
      username: 'admin',
      sessionSecret: 'session-secret-not-real',
    });
    const samples = db.select().from(fleetStateSamples).all();
    expect(samples).toHaveLength(35);
    expect(Math.min(...samples.map((s) => s.active))).toBe(10);
    expect(Math.max(...samples.map((s) => s.active))).toBe(44);
  });

  it('a second run is refused with 2 and writes nothing; the node id, endpoint and port come from the env when set', () => {
    const ledger = nodeLedger(fillProduction);
    const { db, config } = gatewayDb();
    const env = {
      ...NODE_ENV,
      DORMICE_NODE_ID: 'iZ2ze0uezt9j0ca8bgrhqsZ',
      DORMICE_NODE_ENDPOINT: 'http://10.0.0.7:80/',
    };
    expect(
      importNodeLedger(db, config, {
        nodeDbPath: ledger,
        nodeEnv: env,
        now: NOW,
      }).code,
    ).toBe(0);
    expect(db.select().from(nodes).all()).toMatchObject([
      { id: 'iZ2ze0uezt9j0ca8bgrhqsZ', endpoint: 'http://10.0.0.7:80' },
    ]);
    const again = importNodeLedger(db, config, {
      nodeDbPath: ledger,
      nodeEnv: env,
      now: NOW,
    });
    expect(again).toMatchObject({
      code: 2,
      message: expect.stringMatching(/already holds a settings row/),
    });
    expect(listTemplates(db)).toHaveLength(2);
    expect(db.select().from(nodes).all()).toHaveLength(1);
    // A different port in the env shapes the loopback default.
    const { db: db2, config: config2 } = gatewayDb();
    importNodeLedger(db2, config2, {
      nodeDbPath: ledger,
      nodeEnv: { ...NODE_ENV, DORMICE_PORT: '3700' },
      now: NOW,
    });
    expect(db2.select().from(nodes).all()[0]?.endpoint).toBe(
      'http://127.0.0.1:3700',
    );
  });

  it("reads a ledger of another build's shape: an extra column is never asked for, a missing one reads as NULL, an archive default with the store off is dropped; a node already on this cut keeps its copy's base image", () => {
    const ledger = nodeLedger((raw) => {
      fillProduction(raw);
      // The test machine's leftover from an abandoned branch.
      raw.exec('ALTER TABLE api_keys ADD COLUMN delegate text');
      // A ledger from before the fourth cut's columns and the config copy.
      raw.exec('ALTER TABLE runtime_settings DROP COLUMN base_image');
      raw.exec('ALTER TABLE runtime_settings DROP COLUMN registry_address');
      raw.exec('ALTER TABLE runtime_settings DROP COLUMN config_version');
      raw.exec('ALTER TABLE runtime_settings DROP COLUMN updated_at');
      // The store off the old way, a default that still says archive.
      raw.exec(
        "UPDATE runtime_settings SET s3_endpoint = '', default_archive_after_seconds = 604800, pids_limit = NULL WHERE id = 1",
      );
    });
    const { db, config } = gatewayDb({ DORMICE_SANDBOX_PIDS_LIMIT: '2048' });
    const outcome = importNodeLedger(db, config, {
      nodeDbPath: ledger,
      nodeEnv: {},
      now: NOW,
    });
    expect(outcome.code).toBe(0);
    expect(readSettings(db)).toMatchObject({
      s3: null,
      defaultPolicy: expect.objectContaining({ archiveAfterSeconds: null }),
      // NULL in the ledger: the seed's.
      pidsLimit: 2048,
      // No copy column, no env: none — the gateway's late seed or the
      // console fills it.
      baseImage: null,
      registryAddress: null,
      updatedAt: null,
    });
    expect(listApiKeys(db)).toHaveLength(3);

    const onThisCut = nodeLedger((raw) => {
      fillProduction(raw);
      raw.exec(
        "UPDATE runtime_settings SET base_image = 'dormice-base:20260901' WHERE id = 1",
      );
    });
    const fresh = gatewayDb();
    importNodeLedger(fresh.db, fresh.config, {
      nodeDbPath: onThisCut,
      nodeEnv: NODE_ENV,
      now: NOW,
    });
    expect(readSettings(fresh.db).baseImage).toBe('dormice-base:20260901');
  });

  it("a ledger without a settings row is not a daemon's: refused in words, nothing written", () => {
    const ledger = nodeLedger(() => {});
    const { db, config } = gatewayDb();
    expect(() =>
      importNodeLedger(db, config, {
        nodeDbPath: ledger,
        nodeEnv: {},
        now: NOW,
      }),
    ).toThrow(/has no runtime_settings row/);
    expect(db.select().from(nodes).all()).toEqual([]);
  });
});
