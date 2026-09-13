import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMiniS3 } from '@dormice/server/mini-s3';
import type { TestProject } from 'vitest/node';

export interface FleetNodeHandle {
  id: string;
  endpoint: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    dormiceEndpoint: string;
    dormiceToken: string;
    /** The Caddy config file the exam daemon owns — an operator-visible artifact. */
    dormiceIngressFile: string;
    /** The built daemon entry, for tests that boot a daemon of their own. */
    dormiceDaemonMain: string;
    /** Node A's exact environment — a second daemon on the same ledger must refuse to start. */
    dormiceNodeAEnv: Record<string, string>;
    /** The gateway fronting nodes B and C; null in docker mode, where only node A runs. */
    dormiceGatewayEndpoint: string | null;
    /** The fleet's one token: the gateway's, and every fronted node's. */
    dormiceGatewayToken: string | null;
    /** The fronted nodes, reachable directly — to stage what the gateway must then find. */
    dormiceGatewayNodes: FleetNodeHandle[] | null;
    /** The exam's S3, for a node a test boots itself. */
    dormiceMiniS3Url: string;
    /** The built gateway entry, for tests that boot a gateway of their own (its boot refusals). */
    dormiceGatewayMain: string;
  }
}

// The suite is a black box: it boots the daemon exactly the way production
// does (`node dist/main.js` plus environment variables) and talks to it only
// over the wire. Nothing here imports server internals — that is the point;
// this is the safety net that must keep passing while the internals are
// rewritten freely.
const MAIN = fileURLToPath(
  new URL('../../../packages/server/dist/main.js', import.meta.url),
);
const GATEWAY_MAIN = fileURLToPath(
  new URL('../../../packages/gateway/dist/main.js', import.meta.url),
);

interface DaemonSpec {
  /** DORMICE_NODE_ID; omitted keeps the daemon's default, as node A always has. */
  nodeId?: string;
  port: number;
  token: string;
  dataDir: string;
  miniS3Url: string;
  extraEnv?: Record<string, string>;
}

/** Boots one daemon the production way and waits for /healthz. */
async function bootDaemon(spec: DaemonSpec) {
  const endpoint = `http://127.0.0.1:${spec.port}`;
  // An explicit allowlist instead of inheriting the whole environment:
  // whatever DORMICE_* knobs happen to be exported in the developer's shell
  // must not silently reconfigure the daemon under test. The three docker
  // variables pass through on purpose — the documented real-machine e2e run
  // works by exporting exactly those (the daemon's own startup guard is
  // what protects that machine's real sandboxes, not this list).
  const inherited: Record<string, string> = {};
  for (const name of [
    'PATH',
    'DORMICE_EXECUTOR',
    'DORMICE_BASE_IMAGE',
    'DORMICE_DATA_DIR',
  ]) {
    const value = process.env[name];
    if (value !== undefined) {
      inherited[name] = value;
    }
  }
  const env: Record<string, string> = {
    // Exam disks evaporate with the exam: without this default, a docker
    // run without an exported DORMICE_DATA_DIR drops its sandbox disks
    // into /var/lib/dormice — the resident daemon's data dir, whose
    // startup guard then refuses to start (measured 2026-07-10). An
    // exported value still wins through `inherited` below.
    DORMICE_DATA_DIR: spec.dataDir,
    ...inherited,
    ...(spec.nodeId === undefined ? {} : { DORMICE_NODE_ID: spec.nodeId }),
    DORMICE_PORT: String(spec.port),
    DORMICE_DB_PATH: join(spec.dataDir, 'dormice.db'),
    DORMICE_API_TOKEN: spec.token,
    // Sweep every second so lifecycle tests run on second-scale policies
    // instead of the production default of days.
    DORMICE_SCAN_INTERVAL_SECONDS: '1',
    // Sample every second so history verbs have rows to answer with
    // inside a test's lifetime.
    DORMICE_METRICS_SAMPLE_INTERVAL_SECONDS: '1',
    // A wildcard sandbox domain so getHost() and the port proxy are
    // exercised — no DNS needed, tests spoof the Host header locally.
    // A first-boot seed since the setting moved into the ledger: every
    // exam starts on a fresh DB, so the seed lands every run, and
    // settings-hot.test.ts exercises the live edit on top of it.
    DORMICE_SANDBOX_DOMAIN: 'sbx.dormice.test',
    // The archiver, pointed at the exam's mini S3 — likewise a
    // first-boot seed for the ledger's S3 settings. Deliberately NOT in
    // the inherited allowlist: a developer's real DORMICE_S3_* exports
    // must never leak an exam's archives into a production bucket.
    DORMICE_S3_ENDPOINT: spec.miniS3Url,
    DORMICE_S3_BUCKET: 'e2e-archive',
    DORMICE_S3_ACCESS_KEY_ID: 'e2e-key',
    DORMICE_S3_SECRET_ACCESS_KEY: 'e2e-secret',
    DORMICE_S3_FORCE_PATH_STYLE: 'true',
    // A managed ingress so the domain-binding verbs run black-box. The
    // reload command is a no-op: the exam grades what the daemon writes
    // and answers, not Caddy — Caddy's side is real-machine acceptance.
    DORMICE_INGRESS_FILE: join(spec.dataDir, 'Caddyfile'),
    DORMICE_INGRESS_RELOAD_CMD: 'true',
    ...spec.extraEnv,
  };
  const child = spawn('node', [MAIN], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitHealthy(child, endpoint, `daemon ${spec.nodeId ?? 'A'}`);
  return {
    endpoint,
    token: spec.token,
    env,
    ingressFile: join(spec.dataDir, 'Caddyfile'),
    kill: () => child.kill(),
  };
}

async function waitHealthy(
  child: ChildProcess,
  endpoint: string,
  what: string,
): Promise<void> {
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk;
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`${what} exited during startup:\n${output}`);
    }
    try {
      const res = await fetch(`${endpoint}/healthz`);
      if (res.ok) {
        return;
      }
    } catch {
      // Not listening yet; keep probing until the deadline.
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`${what} did not come up within 10s:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export default async function setup(project: TestProject) {
  if (!existsSync(MAIN)) {
    throw new Error(
      `daemon build not found at ${MAIN} — run \`pnpm build\` first`,
    );
  }

  const dataDir = await mkdtemp(join(tmpdir(), 'dormice-e2e-'));
  // Random high base port: never collides with a locally running daemon on
  // 3676 or a gateway on 3677; the fleet takes the next three. Below
  // 32768, where Linux hands out ephemeral ports — a fleet port already
  // taken by some outbound connection would be a boot failure for nothing.
  const base = 20000 + Math.floor(Math.random() * 12000);

  // The exam's own S3 (in-process, test-only): the archive lifecycle runs
  // black-box in every mode — the fake executor exports real files, the
  // store speaks real HTTP. It also mimics OSS's checksum strictness, so a
  // daemon that regressed pit #8 fails here too.
  const miniS3 = await startMiniS3();

  // Node A: the daemon every existing suite talks to, exactly as before —
  // a standalone daemon that checks in with nobody.
  const a = await bootDaemon({
    port: base,
    token: randomBytes(32).toString('hex'),
    dataDir,
    miniS3Url: miniS3.url,
  });
  project.provide('dormiceEndpoint', a.endpoint);
  project.provide('dormiceToken', a.token);
  project.provide('dormiceIngressFile', a.ingressFile);
  project.provide('dormiceDaemonMain', MAIN);
  project.provide('dormiceNodeAEnv', a.env);
  project.provide('dormiceMiniS3Url', miniS3.url);
  project.provide('dormiceGatewayMain', GATEWAY_MAIN);

  // The gateway exam: two more daemons behind a gateway, sharing A's mini
  // S3 bucket the way a real fleet shares one, and sharing one token with
  // the gateway the way a real fleet does. Fake mode only — in docker mode
  // the startup guard judges containers by label across the whole machine,
  // so two daemons on one docker would refuse each other.
  const fleet: Array<{ kill: () => void }> = [];
  const dirs: string[] = [dataDir];
  // Whatever came up before a boot failed is killed here: vitest never
  // calls the teardown of a setup that threw, and a spawned daemon does
  // not die with its parent.
  const abandon = async (error: unknown) => {
    for (const process of fleet.reverse()) process.kill();
    a.kill();
    await miniS3.close();
    throw error;
  };
  if (process.env.DORMICE_EXECUTOR !== 'docker') {
    if (!existsSync(GATEWAY_MAIN)) {
      await abandon(
        new Error(
          `gateway build not found at ${GATEWAY_MAIN} — run \`pnpm build\` first`,
        ),
      );
    }
    const gatewayPort = base + 3;
    const gatewayEndpoint = `http://127.0.0.1:${gatewayPort}`;
    const fleetToken = randomBytes(32).toString('hex');
    // The gateway first, so the nodes' first check-in lands; a gateway
    // that comes up after its nodes learns them at their next check-in
    // anyway, but the exam should not start on that slack.
    const gateway = spawn('node', [GATEWAY_MAIN], {
      env: {
        PATH: process.env.PATH ?? '',
        DORMICE_GATEWAY_PORT: String(gatewayPort),
        DORMICE_GATEWAY_DB_PATH: join(dataDir, 'gateway.db'),
        DORMICE_API_TOKEN: fleetToken,
        // A tiny active limit so the gate can be reached with a handful of
        // sandboxes; the CPU gate is opened wide — a laptop running the
        // suite is not the machine under judgment; the disk floor is off
        // for the same reason.
        DORMICE_GATEWAY_NODE_ACTIVE_LIMIT: '2',
        DORMICE_GATEWAY_NODE_CPU_LIMIT_PCT: '100',
        DORMICE_GATEWAY_NODE_MIN_DISK_GB: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fleet.push({ kill: () => gateway.kill() });
    await waitHealthy(gateway, gatewayEndpoint, 'gateway').catch(abandon);
    const nodes: FleetNodeHandle[] = [];
    for (const [index, id] of (['node-b', 'node-c'] as const).entries()) {
      const nodeDir = await mkdtemp(join(tmpdir(), `dormice-e2e-${id}-`));
      dirs.push(nodeDir);
      const node = await bootDaemon({
        nodeId: id,
        port: base + 1 + index,
        token: fleetToken,
        dataDir: nodeDir,
        miniS3Url: miniS3.url,
        extraEnv: {
          DORMICE_GATEWAY_ENDPOINT: gatewayEndpoint,
          // Second-scale check-ins so a node's readings and its absence
          // show inside a test.
          DORMICE_CHECK_IN_INTERVAL_SECONDS: '1',
        },
      }).catch(abandon);
      fleet.push(node);
      nodes.push({ id, endpoint: node.endpoint });
    }
    project.provide('dormiceGatewayEndpoint', gatewayEndpoint);
    project.provide('dormiceGatewayToken', fleetToken);
    project.provide('dormiceGatewayNodes', nodes);
  } else {
    project.provide('dormiceGatewayEndpoint', null);
    project.provide('dormiceGatewayToken', null);
    project.provide('dormiceGatewayNodes', null);
  }

  return async () => {
    // The nodes first (they stop checking in), then the gateway.
    for (const process of fleet.reverse()) process.kill();
    a.kill();
    await miniS3.close();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  };
}
