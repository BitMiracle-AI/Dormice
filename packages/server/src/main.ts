import { pino } from 'pino';
import { buildApp } from './app';
import { type Config, loadConfig } from './config';
import { migrateDb, openDb } from './db/db';
import { DockerExecutor } from './executor/docker';
import type { Executor } from './executor/executor';
import { FakeExecutor } from './executor/fake';
import { reconcile } from './reconciler';
import { scanOnce } from './scanner';

const config = loadConfig();

// Migrate on every boot: the daemon never runs against a schema it does not
// expect, and a fresh install needs no separate setup step.
const db = openDb(config.DORMICE_DB_PATH);
migrateDb(db, new URL('../drizzle', import.meta.url).pathname);

function buildExecutor(cfg: Config, log: (msg: string) => void): Executor {
  if (cfg.DORMICE_EXECUTOR === 'fake') return new FakeExecutor();
  if (!cfg.DORMICE_BASE_IMAGE) {
    // loadConfig already rejected this combination; the check only narrows
    // the type here.
    throw new Error('DORMICE_BASE_IMAGE is required for the docker executor');
  }
  return new DockerExecutor({
    baseImage: cfg.DORMICE_BASE_IMAGE,
    dataDir: cfg.DORMICE_DATA_DIR,
    diskSizeGb: cfg.DORMICE_SANDBOX_DISK_GB,
    cpus: cfg.DORMICE_SANDBOX_CPUS,
    memoryGb: cfg.DORMICE_SANDBOX_MEMORY_GB,
    pidsLimit: cfg.DORMICE_SANDBOX_PIDS_LIMIT,
    reclaimTimeoutSeconds: cfg.DORMICE_RECLAIM_TIMEOUT_SECONDS,
    log,
  });
}

// One logger, created before everything that needs it: the executor logs
// through it directly and Fastify adopts it as its own.
const log = pino();

const executor = buildExecutor(config, (msg) => log.info(msg));

const app = buildApp({ config, db, executor, logger: log });

// Repair ledger/reality drift left by a crash — before serving traffic, so
// every request runs against a ledger that reflects what actually exists.
// A failure here is fatal on purpose: a daemon that cannot read reality
// should not pretend to manage it.
const repaired = await reconcile(db, executor);
app.log.info(repaired, 'startup reconcile');

// Red line: the daemon binds to loopback only, and the host is deliberately
// not configurable — a knob would be one typo away from 0.0.0.0. Exposing
// the daemon to the outside world is a reverse proxy's job.
await app.listen({ host: '127.0.0.1', port: config.DORMICE_PORT });

// The daemon's heartbeat: reconcile, then scan. Reconciling every tick is
// what keeps the ledger honest while the daemon runs — a container that
// vanished (gVisor kills a whole box on OOM) is deleted from the ledger
// within one interval instead of at the next restart, so acquire stops
// returning it and its user key is free again. Reconcile runs first so the
// scanner never trips over rows whose containers are gone.
//
// Failures are logged, never fatal: the ledger is only written after
// reality moved, so the next tick retries whatever failed.
let suspects: ReadonlySet<string> = new Set();
setInterval(async () => {
  try {
    const drift = await reconcile(db, executor, suspects);
    suspects = new Set(drift.suspects);
    if (drift.repairedStates + drift.deletedRows + drift.destroyedOrphans > 0) {
      app.log.warn(drift, 'runtime reconcile repaired drift');
    }
    const scan = await scanOnce(db, executor, new Date());
    for (const failure of scan.failures) {
      app.log.error(failure, 'idle scan: sandbox transition failed');
    }
  } catch (error) {
    app.log.error(error, 'heartbeat tick failed');
  }
}, config.DORMICE_SCAN_INTERVAL_SECONDS * 1000);
