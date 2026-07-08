import { buildApp } from './app';
import { loadConfig } from './config';
import { migrateDb, openDb } from './db/db';
import { FakeExecutor } from './executor/fake';
import { scanOnce } from './scanner';

const config = loadConfig();

// Migrate on every boot: the daemon never runs against a schema it does not
// expect, and a fresh install needs no separate setup step.
const db = openDb(config.DORMICE_DB_PATH);
migrateDb(db, new URL('../drizzle', import.meta.url).pathname);

// The real Docker+gVisor executor needs a Linux machine and lands later.
// Until then the daemon runs on the in-memory fake: the full lifecycle
// works, but sandboxes cannot execute user code yet.
const executor = new FakeExecutor();

const app = buildApp({ config, db, executor });

// Red line: the daemon binds to loopback only, and the host is deliberately
// not configurable — a knob would be one typo away from 0.0.0.0. Exposing
// the daemon to the outside world is a reverse proxy's job.
await app.listen({ host: '127.0.0.1', port: config.DORMICE_PORT });

// The idle scanner's heartbeat. A failed sweep is logged, never fatal: the
// ledger is only written after reality moved, so the next tick retries
// whatever the failure interrupted.
setInterval(() => {
  scanOnce(db, executor, new Date()).catch((error) => {
    app.log.error(error, 'idle scan failed');
  });
}, config.DORMICE_SCAN_INTERVAL_SECONDS * 1000);
