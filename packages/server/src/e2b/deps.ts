import type { Config } from '../config';
import type { Db } from '../db/db';
import type { Executor } from '../executor/executor';
import type { KeyedQueue } from '../keyed-queue';
import type { ProcessTable } from './process-table';

/**
 * What every compat plugin needs — the native routes' four, plus the
 * process table both e2b prefixes share (control kills what envd started).
 */
export interface E2bDeps {
  config: Config;
  db: Db;
  executor: Executor;
  locks: KeyedQueue;
  processes: ProcessTable;
}
