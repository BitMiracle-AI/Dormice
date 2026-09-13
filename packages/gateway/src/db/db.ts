import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

/**
 * Opens the gateway's database — the daemon's shape (WAL: readers never
 * block the single writer, a crash mid-write cannot corrupt the file).
 */
export function openDb(path: string) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof openDb>;

/** Applies pending migrations (drizzle-kit output, committed) at every start. */
export function migrateDb(db: Db, migrationsFolder: string) {
  migrate(db, { migrationsFolder });
}
