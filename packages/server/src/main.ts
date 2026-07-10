import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { buildApp } from './app';
import { Archiver } from './archive/archiver';
import { S3Store } from './archive/s3-store';
import { type Config, loadConfig, s3Settings } from './config';
import { migrateDb, openDb } from './db/db';
import { listSandboxes } from './db/ledger';
import { acquireSingleWriterLock } from './db/lock';
import { DockerExecutor } from './executor/docker';
import type { Executor } from './executor/executor';
import { FakeExecutor } from './executor/fake';
import { KeyedQueue } from './keyed-queue';
import { reconcile } from './reconciler';
import { scanOnce } from './scanner';
import { locallyClaimedCount, startupGuard } from './startup-guard';

// One logger, created before everything that needs it: the executor logs
// through it directly and Fastify adopts it as its own.
const log = pino();

/** An operator mistake, not a bug: one honest line, no stack trace. */
function fatal(message: string): never {
  log.fatal(message);
  process.exit(1);
}

const config = loadConfig();

// One ledger, one daemon — enforced, not assumed. A second instance would
// run its own destructive reconcile against sandboxes this one is still
// operating, well before it ever loses the race for the port.
if (config.DORMICE_DB_PATH !== ':memory:') {
  try {
    acquireSingleWriterLock(config.DORMICE_DB_PATH);
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error));
  }
}

// Migrate on every boot: the daemon never runs against a schema it does not
// expect, and a fresh install needs no separate setup step.
const db = openDb(config.DORMICE_DB_PATH);
migrateDb(db, fileURLToPath(new URL('../drizzle', import.meta.url)));

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

const executor = buildExecutor(config, (msg) => log.info(msg));

// One queue for the whole daemon: HTTP verbs and the heartbeat's actors
// must share the same per-sandbox slots or the serialization means nothing.
const locks = new KeyedQueue();

// The archiver exists exactly when S3 is configured; without it the daemon
// is byte-for-byte the archive-less daemon. Temp transfers stage next to
// the disks (same filesystem — they are disk-sized, and /tmp may be RAM).
const s3 = s3Settings(config);
let archiver: Archiver | undefined;
if (s3 !== null) {
  archiver = new Archiver({
    db,
    executor,
    locks,
    store: new S3Store(s3),
    tmpDir: path.join(config.DORMICE_DATA_DIR, 'tmp'),
    log: (msg) => log.info(msg),
  });
  await archiver.init();
  log.info(`archiver enabled: bucket ${s3.bucket} at ${s3.endpoint}`);
} else {
  log.info('archiver disabled: DORMICE_S3_* not configured');
}

// The web console ships beside the server in the monorepo; this file sits
// one level under packages/server both as src/main.ts and as dist/main.js,
// so the relative hop to packages/console/dist is the same either way. A
// missing dist is loud but not fatal: the API works without the console.
const consoleDistDir = fileURLToPath(
  new URL('../../console/dist', import.meta.url),
);
if (!existsSync(consoleDistDir)) {
  log.warn(`web console not found at ${consoleDistDir} — /console disabled`);
}

const app = buildApp({
  config,
  db,
  executor,
  locks,
  logger: log,
  consoleDistDir: existsSync(consoleDistDir) ? consoleDistDir : undefined,
  archiver,
});

// Before trusting the pairing of this ledger and this reality, check it:
// reconciliation destroys whatever the ledger disowns, so a daemon booted
// against the wrong ledger, executor or data dir must refuse to start
// instead of erasing sandboxes it merely cannot see.
const refusal = startupGuard({
  ledgerCount: locallyClaimedCount(listSandboxes(db)),
  containers: await executor.listContainers(),
  disks: await executor.listDisks(),
  executor: config.DORMICE_EXECUTOR,
});
if (refusal !== null) {
  fatal(refusal);
}

// Repair ledger/reality drift left by a crash — before serving traffic, so
// every request runs against a ledger that reflects what actually exists.
// A failure here is fatal on purpose: a daemon that cannot read reality
// should not pretend to manage it. The archiver's restore tracker is empty
// at boot, so this pass is also what repairs restoring zombies — before
// listen, so no request ever observes one.
const repaired = await reconcile(db, executor, locks, undefined, archiver);
app.log.info(repaired, 'startup reconcile');

// Red line: the daemon binds to loopback only, and the host is deliberately
// not configurable — a knob would be one typo away from 0.0.0.0. Exposing
// the daemon to the outside world is a reverse proxy's job.
await app.listen({ host: '127.0.0.1', port: config.DORMICE_PORT });

// The daemon's heartbeat: reconcile, then scan. Reconciling every tick is
// what keeps the ledger honest while the daemon runs — a sandbox whose
// container died under it (a gVisor box exits whole on OOM, leaving an
// exited container) is repaired within one interval instead of at the next
// restart. Reconcile runs first so the scanner never trips over rows whose
// containers moved without it.
//
// Ticks are chained instead of put on setInterval: a tick legitimately runs
// long (a single freeze may spend 45s in memory.reclaim), and setInterval
// would start the next tick on top of it — double freezes, repairs from
// stale observations. The next tick is only scheduled when this one is done.
//
// Failures are logged, never fatal: the ledger is only written after
// reality moved, so the next tick retries whatever failed.
let suspects: ReadonlySet<string> = new Set();
async function tick() {
  try {
    const drift = await reconcile(db, executor, locks, suspects, archiver);
    suspects = new Set(drift.suspects);
    if (
      drift.repairedStates +
        drift.deletedRows +
        drift.destroyedOrphans +
        drift.removedDisks +
        drift.archivedSwept >
      0
    ) {
      app.log.warn(drift, 'runtime reconcile repaired drift');
    }
    const scan = await scanOnce(db, executor, locks, new Date(), archiver);
    for (const failure of scan.failures) {
      app.log.error(failure, 'idle scan: sandbox transition failed');
    }
  } catch (error) {
    app.log.error(error, 'heartbeat tick failed');
  } finally {
    setTimeout(tick, config.DORMICE_SCAN_INTERVAL_SECONDS * 1000);
  }
}
setTimeout(tick, config.DORMICE_SCAN_INTERVAL_SECONDS * 1000);
