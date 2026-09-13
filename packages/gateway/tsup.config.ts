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
  // A service, not a library: main.ts is the one entry and nothing imports
  // the package (e2e boots dist/main.js as a process), so no index and no
  // declarations.
  entry: ['src/main.ts'],
  format: ['esm'],
  clean: true,
  env: {
    DORMICE_BUILD_COMMIT: git('rev-parse --short HEAD'),
    DORMICE_BUILD_COMMIT_TITLE: git('log -1 --format=%s'),
    DORMICE_BUILD_COMMIT_AT: commitTime
      ? new Date(commitTime).toISOString()
      : '',
  },
});
