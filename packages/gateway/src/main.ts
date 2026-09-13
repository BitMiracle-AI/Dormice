import { fileURLToPath } from 'node:url';
import { KeyedQueue } from '@dormice/server/keyed-queue';
import { acquireSingleWriterLock } from '@dormice/server/lock';
import { closeWithGrace, trackConnections } from '@dormice/server/shutdown';
import { pino } from 'pino';
import { z } from 'zod';
import { buildGatewayApp } from './app';
import { NameCache } from './cache';
import { loadConfig } from './config';
import { migrateDb, openDb } from './db/db';
import { Finder } from './find';
import { Fleet } from './fleet';
import { httpAskNode } from './lookup';
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

// The fleet from the nodes table (a node that is down is still a node);
// the cache and the readings fill in as nodes report and callers ask.
const fleet = new Fleet(db);
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

const app = buildGatewayApp({
  config,
  fleet,
  finder,
  locks,
  logger: log,
  build,
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
const close = async (signal: NodeJS.Signals) => {
  if (closing) return;
  closing = true;
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
