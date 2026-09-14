import { fileURLToPath } from 'node:url';
import { KeyedQueue } from '@dormice/server/keyed-queue';
import type { CheckInRequest, NodeReading } from '@dormice/shared';
import { buildGatewayApp } from './app';
import { NameCache } from './cache';
import { loadConfig } from './config';
import { migrateDb, openDb } from './db/db';
import { ensureSettings } from './db/settings';
import { Finder } from './find';
import { Fleet } from './fleet';
import { type AskNode, httpAskNode } from './lookup';

/**
 * Test scaffolding shared by the gateway's suites: a node's reading and
 * check-in with a few knobs turned, and a gateway app over an in-memory
 * database for the suites about the gateway's own tables and gates. Not
 * shipped — nothing under src/ but main.ts is bundled (tsup.config.ts).
 */
export const TEST_TOKEN = 'fleet-token-fleet-token-fleet-token-fleet';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

export function reading(
  over: {
    cpu?: number | null;
    cores?: number;
    active?: number;
    frozen?: number;
    memAvail?: number;
    diskAvail?: number | null;
  } = {},
): NodeReading {
  const frozen = over.frozen ?? 0;
  const active = over.active ?? 10;
  return {
    host: {
      cpuCount: over.cores ?? 8,
      cpuUsedPct: over.cpu === undefined ? 10 : over.cpu,
      memTotalBytes: 32e9,
      memAvailableBytes: over.memAvail ?? 16e9,
      swap: null,
    },
    dataDisk:
      over.diskAvail === null
        ? null
        : {
            path: '/var/lib/dormice',
            totalBytes: 1e12,
            usedBytes: 1e12 - (over.diskAvail ?? 5e11),
            availableBytes: over.diskAvail ?? 5e11,
          },
    sandboxes: {
      total: active + frozen,
      byState: { active, frozen, stopped: 0, archived: 0, restoring: 0 },
    },
  };
}

export function checkInOf(
  nodeId: string,
  endpoint: string,
  over: Parameters<typeof reading>[0] & { intervalSeconds?: number } = {},
): CheckInRequest {
  return {
    nodeId,
    endpoint,
    intervalSeconds: over.intervalSeconds ?? 15,
    build: {
      commit: 'abc1234',
      title: 'a commit',
      committedAt: '2026-09-14T00:00:00.000Z',
    },
    reading: reading(over),
  };
}

/**
 * A gateway app over a fresh in-memory database, for app.inject(): the
 * suites about keys, the console and the settings verbs need no node and
 * no socket. Through loadConfig on purpose: defaults are adjudicated once,
 * in the schema.
 */
export function testGateway(
  env: Record<string, string> = {},
  opts: { consoleDistDir?: string; ask?: AskNode } = {},
) {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const config = loadConfig({
    DORMICE_API_TOKEN: TEST_TOKEN,
    DORMICE_GATEWAY_DB_PATH: ':memory:',
    ...env,
  });
  ensureSettings(db, config);
  const fleet = new Fleet(db);
  const finder = new Finder(
    fleet,
    new NameCache(),
    opts.ask ?? httpAskNode(TEST_TOKEN),
    { warn: () => {} },
  );
  const app = buildGatewayApp({
    config,
    db,
    fleet,
    finder,
    locks: new KeyedQueue(),
    logger: false,
    build: null,
    consoleDistDir: opts.consoleDistDir,
  });
  return { app, db, fleet, config };
}
