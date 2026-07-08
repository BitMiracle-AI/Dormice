import { buildApp } from './app';
import { loadConfig } from './config';
import { migrateDb, openDb } from './db/db';

const config = loadConfig();

// Migrate on every boot: the daemon never runs against a schema it does not
// expect, and a fresh install needs no separate setup step.
const db = openDb(config.DORMICE_DB_PATH);
migrateDb(db, new URL('../drizzle', import.meta.url).pathname);

const app = buildApp();

// Red line: the daemon binds to loopback only, and the host is deliberately
// not configurable — a knob would be one typo away from 0.0.0.0. Exposing
// the daemon to the outside world is a reverse proxy's job.
await app.listen({ host: '127.0.0.1', port: config.DORMICE_PORT });
