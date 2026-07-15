/**
 * Library surface of the daemon: importing this has no side effects.
 * Used by integration tests (SDK, e2e) that embed the app on an ephemeral
 * port. Booting the real daemon lives in main.ts.
 */
export { type AppDeps, buildApp } from './app';
export { type Config, loadConfig } from './config';
export { type Db, migrateDb, openDb } from './db/db';
export {
  DockerExecutor,
  type DockerExecutorOptions,
} from './executor/docker';
export type { ContainerState, Executor } from './executor/executor';
export { FakeExecutor } from './executor/fake';
export { KeyedQueue, SKIPPED } from './keyed-queue';
export { type SampleResult, sampleOnce } from './metrics-sampler';
export { type ReconcileResult, reconcile } from './reconciler';
export { type ScanResult, scanOnce } from './scanner';
