import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { buildApp } from './app';
import { Archiver } from './archive/archiver';
import { LedgerArchiveStore } from './archive/ledger-store';
import { CheckIn, readNodeReading } from './check-in';
import { type Config, ignoredEnvKeys, loadConfig } from './config';
import { migrateDb, openDb } from './db/db';
import { listSandboxes } from './db/ledger';
import { acquireSingleWriterLock } from './db/lock';
import {
  readConfigAppliedAt,
  readConfigVersion,
  readNodeConfig,
  readRuntimeSettings,
  readSwapTarget,
} from './db/settings';
import { WatcherTable } from './e2b/watcher-table';
import { DockerExecutor } from './executor/docker';
import type { Executor } from './executor/executor';
import { FakeExecutor } from './executor/fake';
import { gib, HostDiskGrower } from './host-disk';
import { CpuSampler } from './host-metrics';
import { KeyedQueue } from './keyed-queue';
import { sampleOnce } from './metrics-sampler';
import { applyConfig } from './node-config';
import { sweepPidsLimit } from './pids-sweep';
import { reconcile } from './reconciler';
import { scanOnce } from './scanner';
import { closeWithGrace, trackConnections } from './shutdown';
import { locallyClaimedCount, startupGuard } from './startup-guard';
import { SwapManager } from './swap';
import { Updater } from './updater';
import { readBuildInfo } from './version';
import { Watchdog } from './watchdog';

// One logger, created before everything that needs it: the executor logs
// through it directly and Fastify adopts it as its own.
const log = pino();

/** An operator mistake, not a bug: one honest line, no stack trace. */
function fatal(message: string): never {
  log.fatal(message);
  process.exit(1);
}

const config = loadConfig();

// The fleet's operator knobs left the node's environment for the gateway
// (config.ts MOVED_TO_GATEWAY). An env file that still carries them is a
// machine upgraded across the move: say so once, by name, rather than
// silently run on other values than the operator wrote.
const ignored = ignoredEnvKeys();
if (ignored.length > 0) {
  log.warn(
    { ignored },
    `${ignored.length} environment variable${ignored.length === 1 ? '' : 's'} moved to the gateway and ${ignored.length === 1 ? 'does' : 'do'} nothing on a node: ${ignored.join(', ')} — the fleet's settings are the gateway's (its env seeds them once; the console edits them); remove ${ignored.length === 1 ? 'it' : 'them'} from this node's env file`,
  );
}

// One ledger, one daemon — enforced, not assumed. A second instance would
// run its own destructive reconcile against sandboxes this one is still
// operating, well before it ever loses the race for the port. The handle
// is kept for the life of the process: better-sqlite3 closes a handle
// whose object is garbage collected, and a closed handle drops the file
// lock — with the return value discarded, a second daemon on the same
// ledger started fine seconds later (measured 2026-09-11, fake executor).
let ledgerLock: ReturnType<typeof acquireSingleWriterLock> | undefined;
if (config.DORMICE_DB_PATH !== ':memory:') {
  try {
    ledgerLock = acquireSingleWriterLock(config.DORMICE_DB_PATH);
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error));
  }
}

// Migrate on every boot: the daemon never runs against a schema it does not
// expect, and a fresh install needs no separate setup step.
const db = openDb(config.DORMICE_DB_PATH);
migrateDb(db, fileURLToPath(new URL('../drizzle', import.meta.url)));

function buildExecutor(cfg: Config, log: (msg: string) => void): Executor {
  // Live from the ledger: a console edit reaches the next birth directly.
  // Both executors get the same view — the fake on constants would diverge
  // from the wake convergence the moment the defaults move (executor.ts's
  // SandboxResources tells the story).
  const resources = () => {
    const { sandboxDefaults } = readRuntimeSettings(db);
    return {
      diskSizeGb: sandboxDefaults.diskGb,
      cpus: sandboxDefaults.cpus,
      memoryGb: sandboxDefaults.memoryGb,
    };
  };
  // Live too: a console edit reaches the next birth and the next wake's
  // in-place convergence without a restart.
  const pidsLimit = () => readRuntimeSettings(db).pidsLimit;
  if (cfg.DORMICE_EXECUTOR === 'fake') {
    return new FakeExecutor(resources, pidsLimit);
  }
  if (!cfg.DORMICE_BASE_IMAGE) {
    // loadConfig already rejected this combination; the check only narrows
    // the type here.
    throw new Error('DORMICE_BASE_IMAGE is required for the docker executor');
  }
  return new DockerExecutor({
    baseImage: cfg.DORMICE_BASE_IMAGE,
    dataDir: cfg.DORMICE_DATA_DIR,
    resources,
    pidsLimit,
    reclaimTimeoutSeconds: cfg.DORMICE_RECLAIM_TIMEOUT_SECONDS,
    log,
  });
}

const executor = buildExecutor(config, (msg) => log.info(msg));

// The daemon's dead-man switch (see watchdog.ts for the 2026-08-13 incident
// that earned it). Started here, before the boot sequence's own awaits, so
// the startup reconcile is guarded the same as every later heartbeat tick —
// the sweep is the same code either way. Sweeps beat once per row through
// onProgress, and an archive transfer pulses on real bytes moving, so a
// backlog sweep or one big slow upload runs as long as it needs, while an
// await that silently never settles — the failure mode per-call deadlines
// may have missed — is bitten within the stall limit. The bite is a
// crash-only exit: systemd restarts the daemon, startup reconciliation
// squares the ledger with reality, and the ledger already holds every row
// the stuck sweep completed — nothing is lost. Only lifecycle work feeds
// beat: the metrics ticker staying alive is exactly what masked the 08-13
// death, so its liveness must never reassure this watchdog.
const watchdog = new Watchdog({
  stallAfterMs: 30 * 60 * 1000,
  checkEveryMs: 60 * 1000,
  onStall: (stalledForMs) => {
    log.fatal(
      { stalledForMs },
      'daemon made no progress within the stall limit — crash-only exit, systemd brings us back',
    );
    process.exit(1);
  },
});
watchdog.start();
const beat = () => watchdog.beat();

// One queue for the whole daemon: HTTP verbs and the heartbeat's actors
// must share the same per-sandbox slots or the serialization means nothing.
const locks = new KeyedQueue();
const watchers = new WatcherTable();

// One Archiver for the daemon's whole life — its restore tracker is daemon
// memory and must survive configuration changes; whether archiving is
// available is the store provider's live answer from the copy, not a boot
// fact. Temp transfers stage next to the disks (same filesystem — they are
// disk-sized, and /tmp may be RAM).
const archiver = new Archiver({
  db,
  executor,
  locks,
  store: new LedgerArchiveStore(db),
  tmpDir: path.join(config.DORMICE_DATA_DIR, 'tmp'),
  log: (msg) => log.info(msg),
  watchers,
});

// Managed swap exists exactly where the daemon can honor it: a Linux host
// (swapon is the kernel's) running the docker executor (the fake executor
// is a test double — e2e boots real daemons with it, and those must never
// touch the host's swap). Built here, reconciled below once the target is
// known: the target is this node's row of the fleet configuration (the
// gateway's updateNodeSettings), and the reading the check-in carries
// says whether this daemon manages swap at all — null here is how the
// gateway knows to refuse a target for this node.
let swap: SwapManager | undefined;
if (config.DORMICE_EXECUTOR === 'docker' && process.platform === 'linux') {
  swap = new SwapManager({
    dir: path.join(config.DORMICE_DATA_DIR, 'swap'),
    log: (msg) => log.info(msg),
  });
} else {
  log.info('managed swap unavailable: requires Linux + the docker executor');
}

// The build identity, for the check-in and the upgrade window below.
const build = readBuildInfo();

// This node's check-in with its gateway (check-in.ts): its readings, its
// build, where it can be reached, and which configuration version it
// runs — and the fleet's configuration comes back with the answer. Every
// daemon is a node of a gateway (design record #22: a single machine is a
// fleet of one, the gateway on 127.0.0.1:3677 by default). The CpuSampler
// is its own — a delta spans "since this instance's last sample", and the
// route's and the metrics ticker's windows must not be stolen
// (host-metrics.ts). Not primed: the first check-in then reports
// cpuUsedPct null — "no interval yet" — which placement lets through as
// unknown; a sample a few milliseconds before it would make that first
// reading a percentage over the sliver in between, near 0 or near 100 by
// luck (found by review, 2026-09-14).
const nodeEndpoint =
  config.DORMICE_NODE_ENDPOINT ?? `http://127.0.0.1:${config.DORMICE_PORT}`;
const checkInCpu = new CpuSampler();
const checkIn = new CheckIn({
  gateway: config.DORMICE_GATEWAY_ENDPOINT,
  token: config.DORMICE_API_TOKEN,
  nodeId: config.DORMICE_NODE_ID,
  endpoint: nodeEndpoint,
  intervalSeconds: config.DORMICE_CHECK_IN_INTERVAL_SECONDS,
  build,
  readReading: () =>
    readNodeReading(db, checkInCpu, config.DORMICE_DATA_DIR, executor, swap),
  configVersion: () => readConfigVersion(db),
  applyConfig: (bundle) =>
    applyConfig(bundle, { db, executor, locks, swap, log, beat }),
  log,
});

// The daemon's own upgrade window compares the commit baked into this
// build against the checkout it runs from — main.js sits at
// packages/server/dist (src/main.ts at packages/server/src: same depth),
// so three hops up is the repo root either way. No checkout (a dist
// copied elsewhere) means checking is honestly unavailable, not guessed.
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
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
  archiver,
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

// A node without a configuration copy has nothing to build a sandbox from
// — no defaults, no templates, no archive store — so it does not listen
// until it holds one: one check-in now, then one per interval, until the
// gateway answers with the bundle. After the startup guard on purpose: a
// daemon that will refuse to start must not first register itself with
// the fleet. A first install waits for its gateway here (install.sh
// starts the gateway first); a machine upgraded across the move
// (2026-09-14) has its old single-machine settings in the row but no
// copy, and takes the gateway's bundle the same way. The check-ins sent
// meanwhile report "no configuration", which keeps the gateway from
// placing sandboxes here before the port is open (gateway placement.ts):
// listNodes shows such a node with configVersion null until its first
// check-in after listen. A node that already holds a copy runs it, stale
// or not, and takes the current one at that check-in — a node whose
// gateway is away still serves; that is what the copy is for.
if (readConfigVersion(db) === null) {
  log.info(
    `no configuration copy in the ledger — asking gateway ${config.DORMICE_GATEWAY_ENDPOINT} before anything else (retrying every ${config.DORMICE_CHECK_IN_INTERVAL_SECONDS}s until it answers)`,
  );
  // The wait beats the watchdog per attempt (check-in.ts untilConfigured);
  // the ticker started after listen is handed no beat, for the reason the
  // metrics ticker is not (the watchdog's comment above).
  await checkIn.untilConfigured(beat);
}
{
  const copy = readNodeConfig(db);
  log.info(
    {
      version: copy.version,
      appliedAt: readConfigAppliedAt(db),
      templates: copy.templates.length,
      pidsLimit: copy.settings.pidsLimit,
      swapGb: copy.node.swapGb,
      sandboxDomain: copy.settings.sandboxDomain,
    },
    copy.settings.s3 === null
      ? `running configuration v${copy.version}; archiver disabled: no S3 store in the fleet settings (configure one in the console)`
      : `running configuration v${copy.version}; archiver enabled: bucket ${copy.settings.s3.bucket} at ${copy.settings.s3.endpoint}`,
  );
}
if (archiver.enabled()) {
  await archiver.init();
}

// The boot swap reconcile is what makes shrink-by-reboot converge and puts
// grown blocks back after a restart; its failure is loud but not fatal —
// swap is capacity, not correctness. Later moves of the target arrive
// with a bundle (node-config.ts).
if (swap !== undefined) {
  try {
    await swap.reconcile(readSwapTarget(db));
  } catch (error) {
    log.error(error, 'boot swap reconcile failed');
  }
}

// Same eligibility as managed swap, same reasoning: the data-disk auto-grow
// touches the host, so only a real deployment (Linux + docker executor)
// gets one — e2e daemons on the fake executor must never run resize2fs on
// a developer's machine. Within that gate host-disk.ts judges the layout
// itself and declines anything it cannot fully reason about.
const diskGrower =
  config.DORMICE_EXECUTOR === 'docker' && process.platform === 'linux'
    ? new HostDiskGrower({
        dataDir: config.DORMICE_DATA_DIR,
        log: (msg) => log.info(msg),
      })
    : undefined;

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
  beat,
);
app.log.info(repaired, 'startup reconcile');

// Running shells born under another cap follow the ledger now, in place.
// Boot is one of the two moments the cap in force can differ from what a
// running shell carries (the other is updateSettings, which sweeps itself):
// the upgrade that moved the default from 512 to 4096 lands exactly here,
// and the sandboxes at risk of the cap are the busy, running ones — waiting
// for their next wake would have cost each of them one more death.
const swept = await sweepPidsLimit(db, executor, locks, beat);
app.log.info(swept, 'startup pids cap sweep');
app.log.info(
  {
    executor: config.DORMICE_EXECUTOR,
    reconcile: repaired,
    pidsLimit: readRuntimeSettings(db).pidsLimit,
    pidsSweep: { updated: swept.updated, refused: swept.failures.length },
  },
  'daemon started',
);

// Red line: the daemon binds to loopback only, and the host is deliberately
// not configurable — a knob would be one typo away from 0.0.0.0. Exposing
// the daemon to the outside world is a reverse proxy's job.
await app.listen({ host: '127.0.0.1', port: config.DORMICE_PORT });

// The check-in ticker starts after listen on purpose: a check-in names
// where the gateway may forward to and, from now on, reports a
// configuration copy — placement's cue that this node is open for
// business — so that door must be open before the gateway hears it.
checkIn.start();
log.info(
  `node ${config.DORMICE_NODE_ID} checks in with gateway ${config.DORMICE_GATEWAY_ENDPOINT} every ${config.DORMICE_CHECK_IN_INTERVAL_SECONDS}s, reachable at ${nodeEndpoint}`,
);

// systemd stops the daemon with SIGTERM. Shutdown is bounded on purpose
// (shutdown.ts has the measurements): close the app — preClose ends the
// long-lived streams with honest end-frames, the listener stops — give
// in-flight short work SHUTDOWN_GRACE_MS, cut what is still connected, and
// exit. The exit is explicit: an exec attached to dockerd (a background
// process someone started) keeps the event loop alive for as long as the
// process runs, and a daemon that "finished closing" but never exits is
// exactly the 90s-into-SIGKILL stop this replaces. Crash-only makes the
// explicit exit safe — every step is reality-first, the ledger's writes are
// synchronous, and the next boot's reconcile repairs whatever a cut split.
// 10s: an order of magnitude above the longest short step (a cold start,
// a large write) and well under systemd's default TimeoutStopSec of 90s,
// which stays the backstop for a process that cannot even run this code.
// The first signal owns shutdown; a second one still has the platform's
// default behavior instead of leaving a wedged process forever.
const SHUTDOWN_GRACE_MS = 10_000;
const connections = trackConnections(app.server);
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
  checkIn.stop();
  watchdog.stop();
  app.log.info(
    `${signal} received — shutting down (grace ${SHUTDOWN_GRACE_MS}ms)`,
  );
  try {
    const cut = await closeWithGrace(app, connections, SHUTDOWN_GRACE_MS);
    if (cut > 0) {
      app.log.warn(
        { cut },
        'connections still open at the end of the grace period were cut',
      );
    }
  } catch (error) {
    app.log.error(error, `graceful shutdown after ${signal} failed`);
    process.exitCode = 1;
  }
  ledgerLock?.close();
  process.exit(process.exitCode ?? 0);
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
  beat();
  try {
    const drift = await reconcile(
      db,
      executor,
      locks,
      suspects,
      archiver,
      watchers,
      beat,
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
      beat,
    );
    for (const failure of scan.failures) {
      app.log.error(failure, 'idle scan: sandbox transition failed');
    }
  } catch (error) {
    app.log.error(error, 'heartbeat tick failed');
  } finally {
    beat();
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
    // The data-disk auto-grow rides this ticker, deliberately AFTER the
    // sample: the pre-grow reading lands in history, so the curves show
    // the step instead of hiding it. check() spawns resize2fs only when
    // the device's size actually changed (host-disk.ts), so a tick is
    // normally a few /proc + /sys reads. It never throws; the sampler
    // itself stays pure observation.
    const growth = await diskGrower?.check();
    if (growth?.outcome === 'grown') {
      app.log.info(
        { fromGib: gib(growth.fromBytes), toGib: gib(growth.toBytes) },
        'data disk device grew; filesystem resized to fill it',
      );
    }
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
