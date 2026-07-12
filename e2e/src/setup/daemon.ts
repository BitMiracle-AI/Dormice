import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMiniS3 } from '@dormice/server/mini-s3';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    dormiceEndpoint: string;
    dormiceToken: string;
    /** The Caddy config file the exam daemon owns — an operator-visible artifact. */
    dormiceIngressFile: string;
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

export default async function setup(project: TestProject) {
  if (!existsSync(MAIN)) {
    throw new Error(
      `daemon build not found at ${MAIN} — run \`pnpm build\` first`,
    );
  }

  const token = randomBytes(32).toString('hex');
  const dataDir = await mkdtemp(join(tmpdir(), 'dormice-e2e-'));
  // Random high port: never collides with a locally running daemon on 3676.
  const port = 20000 + Math.floor(Math.random() * 20000);
  const endpoint = `http://127.0.0.1:${port}`;

  // The exam's own S3 (in-process, test-only): the archive lifecycle runs
  // black-box in every mode — the fake executor exports real files, the
  // store speaks real HTTP. It also mimics OSS's checksum strictness, so a
  // daemon that regressed pit #8 fails here too.
  const miniS3 = await startMiniS3();

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
  const child = spawn('node', [MAIN], {
    env: {
      // Exam disks evaporate with the exam: without this default, a docker
      // run without an exported DORMICE_DATA_DIR drops its sandbox disks
      // into /var/lib/dormice — the resident daemon's data dir, whose
      // startup guard then refuses to start (measured 2026-07-10). An
      // exported value still wins through `inherited` below.
      DORMICE_DATA_DIR: dataDir,
      ...inherited,
      DORMICE_PORT: String(port),
      DORMICE_DB_PATH: join(dataDir, 'dormice.db'),
      DORMICE_API_TOKEN: token,
      // Sweep every second so lifecycle tests run on second-scale policies
      // instead of the production default of days.
      DORMICE_SCAN_INTERVAL_SECONDS: '1',
      // A wildcard sandbox domain so getHost() and the port proxy are
      // exercised — no DNS needed, tests spoof the Host header locally.
      DORMICE_SANDBOX_DOMAIN: 'sbx.dormice.test',
      // The archiver, pointed at the exam's mini S3. Deliberately NOT in
      // the inherited allowlist: a developer's real DORMICE_S3_* exports
      // must never leak an exam's archives into a production bucket.
      DORMICE_S3_ENDPOINT: miniS3.url,
      DORMICE_S3_BUCKET: 'e2e-archive',
      DORMICE_S3_ACCESS_KEY_ID: 'e2e-key',
      DORMICE_S3_SECRET_ACCESS_KEY: 'e2e-secret',
      DORMICE_S3_FORCE_PATH_STYLE: 'true',
      // A managed ingress so the domain-binding verbs run black-box. The
      // reload command is a no-op: the exam grades what the daemon writes
      // and answers, not Caddy — Caddy's side is real-machine acceptance.
      DORMICE_INGRESS_FILE: join(dataDir, 'Caddyfile'),
      DORMICE_INGRESS_RELOAD_CMD: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`daemon exited during startup:\n${output}`);
    }
    try {
      const res = await fetch(`${endpoint}/healthz`);
      if (res.ok) {
        break;
      }
    } catch {
      // Not listening yet; keep probing until the deadline.
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`daemon did not come up within 10s:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  project.provide('dormiceEndpoint', endpoint);
  project.provide('dormiceToken', token);
  project.provide('dormiceIngressFile', join(dataDir, 'Caddyfile'));

  return async () => {
    child.kill();
    await miniS3.close();
    await rm(dataDir, { recursive: true, force: true });
  };
}
