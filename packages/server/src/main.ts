import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { buildApp } from './app';
import { Archiver } from './archive/archiver';
import { S3Store } from './archive/s3-store';
import { type Config, loadConfig, s3Settings } from './config';
import { recordActivity } from './db/activity';
import { migrateDb, openDb } from './db/db';
import { listSandboxes } from './db/ledger';
import { acquireSingleWriterLock } from './db/lock';
import { ensureRuntimeSettings, readRuntimeSettings } from './db/settings';
import { WatcherTable } from './e2b/watcher-table';
import { DockerExecutor } from './executor/docker';
import type { Executor } from './executor/executor';
import { FakeExecutor } from './executor/fake';
import { CpuSampler } from './host-metrics';
import { Ingress } from './ingress';
import { KeyedQueue } from './keyed-queue';
import { sampleOnce } from './metrics-sampler';
import { ARCHIVE_DEFAULT_SECONDS } from './policy';
import { reconcile } from './reconciler';
import { scanOnce } from './scanner';
import { locallyClaimedCount, startupGuard } from './startup-guard';
import { SwapManager } from './swap';
import { Updater } from './updater';
import { readBuildInfo } from './version';

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

// Seed the runtime settings before anything can read a knob (the executor
// reads them at every disk/container birth). The archive adjudication here
// is the same one buildApp makes: archiver exists iff S3 is configured.
ensureRuntimeSettings(
  db,
  config,
  s3Settings(config) !== null ? ARCHIVE_DEFAULT_SECONDS : null,
);

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
    // Live from the ledger: a console edit reaches the next birth directly.
    resources: () => {
      const { sandboxDefaults } = readRuntimeSettings(db);
      return {
        diskSizeGb: sandboxDefaults.diskGb,
        cpus: sandboxDefaults.cpus,
        memoryGb: sandboxDefaults.memoryGb,
      };
    },
    pidsLimit: cfg.DORMICE_SANDBOX_PIDS_LIMIT,
    reclaimTimeoutSeconds: cfg.DORMICE_RECLAIM_TIMEOUT_SECONDS,
    log,
  });
}

const executor = buildExecutor(config, (msg) => log.info(msg));

// One queue for the whole daemon: HTTP verbs and the heartbeat's actors
// must share the same per-sandbox slots or the serialization means nothing.
const locks = new KeyedQueue();
const watchers = new WatcherTable();

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
    watchers,
  });
  await archiver.init();
  log.info(`archiver enabled: bucket ${s3.bucket} at ${s3.endpoint}`);
} else {
  log.info('archiver disabled: DORMICE_S3_* not configured');
}

// The managed front door exists exactly when its file knob is set (the
// archiver's rule). The file itself is the source of truth for the bound
// domains — nothing to reconcile at boot, Caddy is already running it.
let ingress: Ingress | undefined;
if (config.DORMICE_INGRESS_FILE) {
  ingress = new Ingress({
    filePath: config.DORMICE_INGRESS_FILE,
    upstreamPort: config.DORMICE_PORT,
    reloadCommand: config.DORMICE_INGRESS_RELOAD_CMD,
  });
  const domains = ingress.domains();
  log.info(
    `ingress managed at ${config.DORMICE_INGRESS_FILE}: ${domains.length ? domains.join(', ') : 'no domain bound (IP access only)'}`,
  );
} else {
  log.info('ingress not managed: DORMICE_INGRESS_FILE not configured');
}

// Managed swap exists exactly where the daemon can honor it: a Linux host
// (swapon is the kernel's) running the docker executor (the fake executor
// is a test double — e2e boots real daemons with it, and those must never
// touch the host's swap). The boot reconcile is what makes shrink-by-
// reboot converge and puts grown blocks back after a restart; its failure
// is loud but not fatal — swap is capacity, not correctness, and
// getConfig's swap.activeGb reports the shortfall honestly.
let swap: SwapManager | undefined;
if (config.DORMICE_EXECUTOR === 'docker' && process.platform === 'linux') {
  swap = new SwapManager({
    dir: path.join(config.DORMICE_DATA_DIR, 'swap'),
    log: (msg) => log.info(msg),
  });
  try {
    await swap.reconcile(readRuntimeSettings(db).swapGb);
  } catch (error) {
    log.error(error, 'boot swap reconcile failed');
  }
} else {
  log.info('managed swap unavailable: requires Linux + the docker executor');
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

// The daemon's own upgrade window compares the commit baked into this
// build against the checkout it runs from — main.js sits at
// packages/server/dist (src/main.ts at packages/server/src: same depth),
// so three hops up is the repo root either way. No checkout (a dist
// copied elsewhere) means checking is honestly unavailable, not guessed.
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const build = readBuildInfo();
const updater = new Updater({
  repoDir: existsSync(path.join(repoRoot, '.git')) ? repoRoot : null,
  build,
  statusDir: path.join(config.DORMICE_DATA_DIR, 'upgrade'),
  executor: config.DORMICE_EXECUTOR,
});
log.info(
  build
    ? `dormice build ${build.commit} (${build.title})`
    : 'dormice build: no version identity (built outside a git checkout)',
);

const app = buildApp({
  config,
  db,
  executor,
  locks,
  logger: log,
  consoleDistDir: existsSync(consoleDistDir) ? consoleDistDir : undefined,
  archiver,
  ingress,
  swap,
  updater,
  watchers,
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
const repaired = await reconcile(
  db,
  executor,
  locks,
  undefined,
  archiver,
  watchers,
);
app.log.info(repaired, 'startup reconcile');
recordActivity(db, {
  kind: 'daemon-started',
  detail:
    `executor ${config.DORMICE_EXECUTOR}; startup reconcile: ` +
    `${repaired.repairedStates} states repaired, ${repaired.deletedRows} rows deleted, ` +
    `${repaired.destroyedOrphans} orphan containers destroyed, ${repaired.removedDisks} disks removed`,
});

// Red line: the daemon binds to loopback only, and the host is deliberately
// not configurable — a knob would be one typo away from 0.0.0.0. Exposing
// the daemon to the outside world is a reverse proxy's job.
await app.listen({ host: '127.0.0.1', port: config.DORMICE_PORT });

// systemd stops the daemon with SIGTERM. Route both terminal signals through
// Fastify so preClose can end long-lived streams and reap watcher ownership
// before Node exits. The first signal owns shutdown; a second one still has
// the platform's default behavior instead of leaving a wedged process forever.
let closing = false;
let heartbeatTimer: NodeJS.Timeout | undefined;
let metricsTimer: NodeJS.Timeout | undefined;
const close = async (signal: NodeJS.Signals) => {
  if (closing) return;
  closing = true;
  process.removeListener('SIGTERM', onSigterm);
  process.removeListener('SIGINT', onSigint);
  clearTimeout(heartbeatTimer);
  clearTimeout(metricsTimer);
  try {
    await app.close();
  } catch (error) {
    app.log.error(error, `graceful shutdown after ${signal} failed`);
    process.exitCode = 1;
  }
};
const onSigterm = () => void close('SIGTERM');
const onSigint = () => void close('SIGINT');
process.once('SIGTERM', onSigterm);
process.once('SIGINT', onSigint);

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
    const drift = await reconcile(
      db,
      executor,
      locks,
      suspects,
      archiver,
      watchers,
    );
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
    const scan = await scanOnce(
      db,
      executor,
      locks,
      new Date(),
      archiver,
      watchers,
    );
    for (const failure of scan.failures) {
      app.log.error(failure, 'idle scan: sandbox transition failed');
    }
  } catch (error) {
    app.log.error(error, 'heartbeat tick failed');
  } finally {
    if (!closing) {
      heartbeatTimer = setTimeout(
        tick,
        config.DORMICE_SCAN_INTERVAL_SECONDS * 1000,
      );
    }
  }
}
heartbeatTimer = setTimeout(tick, config.DORMICE_SCAN_INTERVAL_SECONDS * 1000);

// The metrics sampler's own chained ticker — deliberately not a passenger
// on the heartbeat, whose ticks legitimately run 45s+ (memory.reclaim) and
// would turn the sampling cadence into jitter. The first shot fires
// immediately: a restart's gap in the curves should equal the downtime, not
// downtime plus one interval. Same failure stance as the heartbeat: log,
// never fatal, next tick retries.
//
// The ticker's private CpuSampler, primed here so even the immediate first
// tick has a (short) interval to report on. Private because a CPU delta
// spans "since this instance's last sample": the getHostMetrics route owns
// a separate instance, and sharing would let console polls steal windows.
const hostCpu = new CpuSampler();
hostCpu.sample();
async function metricsTick() {
  try {
    await sampleOnce(db, executor, new Date(), {
      retentionHours: config.DORMICE_METRICS_RETENTION_HOURS,
      hostCpu,
      dataDir: config.DORMICE_DATA_DIR,
    });
  } catch (error) {
    app.log.error(error, 'metrics sampler tick failed');
  } finally {
    if (!closing) {
      metricsTimer = setTimeout(
        metricsTick,
        config.DORMICE_METRICS_SAMPLE_INTERVAL_SECONDS * 1000,
      );
    }
  }
}
metricsTimer = setTimeout(metricsTick, 0);
