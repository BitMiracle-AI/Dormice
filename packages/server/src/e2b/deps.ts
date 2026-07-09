import type { Config } from '../config';
import type { Db } from '../db/db';
import type { Executor } from '../executor/executor';
import type { KeyedQueue } from '../keyed-queue';

/** What every compat plugin needs — the same four the native routes get. */
export interface E2bDeps {
  config: Config;
  db: Db;
  executor: Executor;
  locks: KeyedQueue;
}
