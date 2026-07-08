/**
 * Library surface of the daemon: importing this has no side effects.
 * Used by integration tests (SDK, e2e) that embed the app on an ephemeral
 * port. Booting the real daemon lives in main.ts.
 */
export { type AppDeps, buildApp } from './app';
export { type Config, loadConfig } from './config';
export { type Db, migrateDb, openDb } from './db/db';
export type { Executor } from './executor/executor';
export { type FakeContainerState, FakeExecutor } from './executor/fake';
export { type ScanResult, scanOnce } from './scanner';
