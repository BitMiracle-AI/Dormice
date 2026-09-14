import { fileURLToPath } from 'node:url';
import { KeyedQueue } from '@dormice/server/keyed-queue';
import type { CheckInRequest, NodeReading } from '@dormice/shared';
import { buildGatewayApp } from './app';
import { NameCache } from './cache';
import { configSources, loadConfig } from './config';
import { migrateDb, openDb } from './db/db';
import { ensureSettings } from './db/settings';
import { Finder } from './find';
import { Fleet } from './fleet';
import type { Ingress } from './ingress';
import { type AskNode, type AskVerb, httpAskNode } from './lookup';

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
    archived?: number;
    restoring?: number;
    memAvail?: number;
    diskAvail?: number | null;
  } = {},
): NodeReading {
  const frozen = over.frozen ?? 0;
  const active = over.active ?? 10;
  const archived = over.archived ?? 0;
  const restoring = over.restoring ?? 0;
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
      total: active + frozen + archived + restoring,
      byState: { active, frozen, stopped: 0, archived, restoring },
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
  opts: {
    consoleDistDir?: string;
    ask?: AskNode;
    /** Scripted answers to the verbs the gateway asks nodes itself (templateUsers). */
    askVerb?: AskVerb;
    ingress?: Ingress;
    /** Forged by default: the suites here are about the settings machinery, not S3's availability. */
    probeS3?: NonNullable<Parameters<typeof buildGatewayApp>[0]['probeS3']>;
  } = {},
) {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const rawEnv = {
    DORMICE_API_TOKEN: TEST_TOKEN,
    DORMICE_GATEWAY_DB_PATH: ':memory:',
    ...env,
  };
  const config = loadConfig(rawEnv);
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
    ingress: opts.ingress,
    ask: opts.askVerb,
    probeS3: opts.probeS3 ?? (() => Promise.resolve()),
    // Off the same raw env the config was parsed from, through the real
    // function: the parsed object drops unset optional knobs, so deriving
    // sources from its keys would leave those entries without a source.
    sources: configSources(rawEnv),
  });
  return { app, db, fleet, config };
}
