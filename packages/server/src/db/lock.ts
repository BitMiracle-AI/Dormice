import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Takes an exclusive, process-lifetime lock next to the ledger, so a second
 * daemon on the same ledger dies at boot instead of running its own
 * destructive reconcile against sandboxes the first daemon is still
 * operating. "Single process, single writer" is the ledger's founding
 * assumption, and nothing else enforces it — SQLite's WAL happily accepts
 * writers from several processes.
 *
 * The lock is an OS-level file lock held by a dedicated SQLite handle in
 * EXCLUSIVE locking mode: released the instant the process dies, crash
 * included, so there is no stale-pidfile problem to solve.
 */
export function acquireSingleWriterLock(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  // Fail fast: a held lock answers in 100ms instead of the default 5s wait.
  const lock = new Database(`${dbPath}.lock`, { timeout: 100 });
  try {
    lock.pragma('locking_mode = EXCLUSIVE');
    // The first write under EXCLUSIVE mode takes the file lock and keeps it
    // for the life of this handle. The pid is only a debugging courtesy.
    lock.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER)');
    lock.exec(
      `DELETE FROM holder; INSERT INTO holder (pid) VALUES (${process.pid});`,
    );
  } catch (error) {
    lock.close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY') {
      throw new Error(
        `another daemon is already running against ${dbPath} — one ledger, one daemon. ` +
          'Stop the other instance, or point this one at its own DORMICE_DB_PATH.',
      );
    }
    throw error;
  }
  return lock;
}
