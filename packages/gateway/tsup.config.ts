import { execSync } from 'node:child_process';
import { defineConfig } from 'tsup';

/**
 * Same build identity as the daemon (packages/server/tsup.config.ts has
 * the reasoning): the commit the dist was built from, baked in as
 * literals that src/version.ts reads back — what the process IS, not what
 * the checkout says after a pull.
 */
function git(args: string): string {
  try {
    return execSync(`git ${args}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

const commitTime = git('log -1 --format=%cI');

export default defineConfig({
  // A service first: main.ts is the entry e2e boots as a process. The
  // index is the library surface the SDK's and the CLI's suites embed a
  // gateway through (the verbs they test for keys, settings and templates
  // answer at the gateway), so it ships with declarations like the
  // daemon's. import.ts is the one-time ledger import install.sh runs
  // before the gateway's first start (import-ledger.ts).
  entry: ['src/main.ts', 'src/index.ts', 'src/import.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  env: {
    DORMICE_BUILD_COMMIT: git('rev-parse --short HEAD'),
    DORMICE_BUILD_COMMIT_TITLE: git('log -1 --format=%s'),
    DORMICE_BUILD_COMMIT_AT: commitTime
      ? new Date(commitTime).toISOString()
      : '',
  },
});
