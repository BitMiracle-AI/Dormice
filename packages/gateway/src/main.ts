import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KeyedQueue } from '@dormice/server/keyed-queue';
import { acquireSingleWriterLock } from '@dormice/server/lock';
import { closeWithGrace, trackConnections } from '@dormice/server/shutdown';
import { pino } from 'pino';
import { z } from 'zod';
import { buildGatewayApp } from './app';
import { httpAskNode } from './ask';
import { NameCache } from './cache';
import { loadConfig } from './config';
import { migrateDb, openDb } from './db/db';
import { recordFleetSample } from './db/fleet-samples';
import { ensureSettings } from './db/settings';
import { Finder } from './find';
import { Fleet } from './fleet';
import { Ingress } from './ingress';
import { readBuildInfo } from './version';

const log = pino();

/** An operator mistake, not a bug: one honest line, no stack trace. */
function fatal(error: unknown): never {
  log.fatal(
    error instanceof z.ZodError
      ? z.prettifyError(error)
      : error instanceof Error
        ? error.message
        : String(error),
  );
  process.exit(1);
}

const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    return fatal(error);
  }
})();

// One database file, one gateway — enforced, not assumed (the daemon's own
// lock over the gateway's file). The handle is kept for the life of the
// process on purpose: better-sqlite3 closes a handle when its object is
// garbage collected, and a closed handle drops the file lock (measured
// 2026-09-11 on the daemon with a discarded return value).
let lock: ReturnType<typeof acquireSingleWriterLock> | undefined;
if (config.DORMICE_GATEWAY_DB_PATH !== ':memory:') {
  try {
    lock = acquireSingleWriterLock(
      config.DORMICE_GATEWAY_DB_PATH,
      `another gateway is already running against ${config.DORMICE_GATEWAY_DB_PATH} — one database, one gateway. Stop the other instance, or point this one at its own DORMICE_GATEWAY_DB_PATH.`,
    );
  } catch (error) {
    fatal(error);
  }
}

// Migrate on every boot; a fresh install needs no separate setup step.
const db = openDb(config.DORMICE_GATEWAY_DB_PATH);
migrateDb(db, fileURLToPath(new URL('../drizzle', import.meta.url)));
// The fleet's settings row, seeded from the env exactly once (db/settings.ts).
ensureSettings(db, config);

// The fleet from the nodes table, each node as of its last check-in (a
// node that is down is still a node, and a restart forgets nothing the
// rows hold); the cache fills in as callers ask.
const fleet = new Fleet(db, log);
const finder = new Finder(
  fleet,
  new NameCache(),
  httpAskNode(config.DORMICE_API_TOKEN),
  log,
);

// One queue for the whole gateway: the native acquire/destroy and the E2B
// create/kill must share per-name slots or the serialization means nothing.
const locks = new KeyedQueue();

const build = readBuildInfo();
log.info(
  build
    ? `dormice-gateway build ${build.commit} (${build.title})`
    : 'dormice-gateway build: no version identity (built outside a git checkout)',
);

// The managed front door, present exactly when the knob names a file
// (the archiver precedent). The upstream is this gateway: the fleet's one
// public Caddy sits in front of the one door.
const ingress =
  config.DORMICE_INGRESS_FILE === undefined
    ? undefined
    : new Ingress({
        filePath: config.DORMICE_INGRESS_FILE,
        upstreamPort: config.DORMICE_GATEWAY_PORT,
        ...(config.DORMICE_INGRESS_RELOAD_CMD
          ? { reloadCommand: config.DORMICE_INGRESS_RELOAD_CMD }
          : {}),
      });
if (ingress) {
  log.info(
    `managed ingress: ${config.DORMICE_INGRESS_FILE} (domains bound from the console reach this gateway)`,
  );
}

// The built web console, by the monorepo layout: dist/main.js sits two
// levels under packages/gateway, the console's dist beside it. Absent
// (a deploy without the console built), /console answers an honest 404.
const consoleDistDir = fileURLToPath(
  new URL('../../console/dist', import.meta.url),
);
if (!existsSync(consoleDistDir)) {
  log.warn(`web console not found at ${consoleDistDir} — /console disabled`);
}

const app = buildGatewayApp({
  config,
  db,
  fleet,
  finder,
  locks,
  logger: log,
  build,
  consoleDistDir: existsSync(consoleDistDir) ? consoleDistDir : undefined,
  ingress,
});

// Same red line as the daemon: loopback only, host not configurable — the
// public face is a reverse proxy's job. Nothing is awaited before the door
// opens: the nodes report themselves within one interval, and until then
// a new name is refused with placement's honest 503 while every existing
// sandbox is found by asking.
await app.listen({ host: '127.0.0.1', port: config.DORMICE_GATEWAY_PORT });
const known = fleet.all();
log.info(
  known.length === 0
    ? 'no node has checked in yet; nodes join the fleet at their first check-in'
    : `fronting ${known.length} node(s) from the last run: ${known.map((n) => `${n.id} at ${n.endpoint}`).join(', ')} — each is placed on again after its first check-in`,
);

// Bounded shutdown, the daemon's (packages/server/src/shutdown.ts has the
// measurements): close the listener, give in-flight short work the grace,
// cut what is still connected — a forwarded exec may legitimately live for
// hours — and exit explicitly.
const SHUTDOWN_GRACE_MS = 10_000;
const connections = trackConnections(app.server);
let closing = false;

// The fleet's state sampler — the gateway's one clock of its own, the
// daemon's metrics ticker in shape (server/main.ts): every interval one
// row of the fleet's census, summed from every node's last reading
// (db/fleet-samples.ts says when no row is true enough to write). The
// first tick is at boot, as the daemon's: the readings come back from
// the nodes' rows (fleet.ts), so the first row after a restart is the
// fleet as of just before it and the curve's gap is the downtime — the
// third cut, with the readings in memory only, had to wait an interval
// for the nodes to report again (measured 2026-09-15: 0.6s down, a 54s
// gap) and deleted the boot shot as necessarily empty; the rows turned
// that around. Same failure stance: log, never fatal, the next tick
// retries — and no check-in ever waits on this write.
const sampleIntervalMs = config.DORMICE_GATEWAY_SAMPLE_INTERVAL_SECONDS * 1000;
let sampleTimer: NodeJS.Timeout | undefined;
function sampleTick() {
  try {
    recordFleetSample(db, fleet, new Date());
  } catch (error) {
    app.log.error(error, 'fleet state sample failed');
  } finally {
    if (!closing) sampleTimer = setTimeout(sampleTick, sampleIntervalMs);
  }
}
sampleTimer = setTimeout(sampleTick, 0);

const close = async (signal: NodeJS.Signals) => {
  if (closing) return;
  closing = true;
  clearTimeout(sampleTimer);
  process.removeListener('SIGTERM', onSigterm);
  process.removeListener('SIGINT', onSigint);
  app.log.info(
    `${signal} received — shutting down (grace ${SHUTDOWN_GRACE_MS}ms)`,
  );
  try {
    const cut = await closeWithGrace(app, connections, SHUTDOWN_GRACE_MS);
    if (cut > 0) {
      app.log.warn(
        { cut },
        'connections still open at the end of the grace period were cut',
      );
    }
  } catch (error) {
    app.log.error(error, `graceful shutdown after ${signal} failed`);
    process.exitCode = 1;
  }
  lock?.close();
  process.exit(process.exitCode ?? 0);
};
const onSigterm = () => void close('SIGTERM');
const onSigint = () => void close('SIGINT');
process.once('SIGTERM', onSigterm);
process.once('SIGINT', onSigint);
