import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    dormiceEndpoint: string;
    dormiceToken: string;
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

  const child = spawn('node', [MAIN], {
    env: {
      ...process.env,
      DORMICE_PORT: String(port),
      DORMICE_DB_PATH: join(dataDir, 'dormice.db'),
      DORMICE_API_TOKEN: token,
      // Sweep every second so lifecycle tests run on second-scale policies
      // instead of the production default of days.
      DORMICE_SCAN_INTERVAL_SECONDS: '1',
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

  return async () => {
    child.kill();
    await rm(dataDir, { recursive: true, force: true });
  };
}
