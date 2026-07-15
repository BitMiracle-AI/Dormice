import type { Archiver } from '../archive/archiver';
import type { Config } from '../config';
import type { Db } from '../db/db';
import type { Executor } from '../executor/executor';
import type { KeyedQueue } from '../keyed-queue';
import type { ProcessTable } from './process-table';
import type { WatcherTable } from './watcher-table';

/**
 * What every compat plugin needs — the native routes' four, plus the
 * process table both e2b prefixes share (control kills what envd started)
 * and the polling watchers' table.
 */
export interface E2bDeps {
  config: Config;
  db: Db;
  executor: Executor;
  locks: KeyedQueue;
  processes: ProcessTable;
  watchers: WatcherTable;
  /**
   * Present exactly when S3 is configured. E2B has no restoring concept,
   * so this surface's verbs block on restoreJoin — resuming an archived
   * sandbox just takes longer, which is the faithful behavior.
   */
  archiver?: Archiver;
  /** buildApp's one adjudication of the archive policy default (null = off). */
  archiveDefaultSeconds: number | null;
  /**
   * HMAC key for envd access tokens and signed URLs — the ledger's
   * signing secret, never the API token (they rotate independently).
   */
  envdSigningSecret: string;
}
