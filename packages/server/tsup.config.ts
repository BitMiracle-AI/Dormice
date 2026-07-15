import { execSync } from 'node:child_process';
import { defineConfig } from 'tsup';

/**
 * The build stamps its own identity: the commit the dist was built from,
 * baked in as literals (src/version.ts reads them back). Deliberately
 * build-time, not runtime — after a `git pull` the checkout's HEAD moves
 * while the running process does not, and the daemon must report what it
 * IS, not what the directory says. Built outside a git checkout, the
 * values are empty and version.ts honestly answers null.
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
  entry: ['src/index.ts', 'src/main.ts', 'src/archive/mini-s3.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  env: {
    DORMICE_BUILD_COMMIT: git('rev-parse --short HEAD'),
    DORMICE_BUILD_COMMIT_TITLE: git('log -1 --format=%s'),
    // Normalized to UTC here so the wire schema keeps its one timestamp
    // shape (ISO 8601 UTC) — %cI carries the author's local offset.
    DORMICE_BUILD_COMMIT_AT: commitTime
      ? new Date(commitTime).toISOString()
      : '',
  },
});
