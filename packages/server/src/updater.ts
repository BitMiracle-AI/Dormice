import type { CheckUpgradeResponse } from '@dormice/shared';
import { execa } from 'execa';
import type { BuildInfo } from './version';

/**
 * The daemon's own upgrade window. Versions are git commits (trunk-based,
 * no release tags yet), and the question "is a newer Dormice available?"
 * is answered by comparing the commit baked into this build against the
 * origin's main — fetched through the checkout's own `origin` remote, so
 * an install done with `--mirror cn` (whose clone URL carries the mirror
 * prefix) checks through the same mirror for free.
 *
 * `git fetch` updates .git only and never touches the working tree or the
 * running process — checking is always safe. The result is cached so a
 * console session does not hammer the network; `force` is the "check now"
 * button. Failures come back as data (checkError), never invented.
 */

const CHECK_CACHE_MS = 3600_000;
/** Changelog preview cap — the wire is a preview, not the full history. */
const CHANGELOG_LIMIT = 50;
const FETCH_TIMEOUT_MS = 30_000;

export interface UpdaterOptions {
  /**
   * Root of the git checkout the daemon runs from; null when there is
   * none (a dist copied around, tests) — checking is then honestly
   * impossible instead of quietly comparing the wrong repository.
   */
  repoDir: string | null;
  /** The identity baked into this build (version.ts). */
  build: BuildInfo | null;
}

type Check = NonNullable<CheckUpgradeResponse['check']>;

export class Updater {
  private readonly repoDir: string | null;
  private readonly build: BuildInfo | null;
  private cache: { at: number; check: Check } | null = null;

  constructor(options: UpdaterOptions) {
    this.repoDir = options.repoDir;
    this.build = options.build;
  }

  async check(force = false): Promise<CheckUpgradeResponse> {
    if (this.repoDir === null) {
      return {
        current: this.build,
        check: null,
        checkError:
          'the daemon does not run from a git checkout — nothing to compare against',
      };
    }
    if (this.build === null) {
      return {
        current: null,
        check: null,
        checkError:
          'this build carries no version identity (built outside a git checkout) — nothing to compare',
      };
    }
    if (!force && this.cache && Date.now() - this.cache.at < CHECK_CACHE_MS) {
      return {
        current: this.build,
        check: { ...this.cache.check, cached: true },
        checkError: null,
      };
    }
    try {
      const check = await this.compare(this.build.commit);
      this.cache = { at: Date.now(), check };
      return { current: this.build, check, checkError: null };
    } catch (error) {
      return {
        current: this.build,
        check: null,
        checkError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async compare(currentCommit: string): Promise<Check> {
    // FETCH_HEAD instead of origin/main: it is written by every fetch
    // regardless of the clone's refspec configuration.
    await this.git(['fetch', '--quiet', 'origin', 'main'], FETCH_TIMEOUT_MS);
    const behindBy = Number(
      await this.git(['rev-list', '--count', `${currentCommit}..FETCH_HEAD`]),
    );
    const aheadBy = Number(
      await this.git(['rev-list', '--count', `FETCH_HEAD..${currentCommit}`]),
    );
    const latest = parseCommitLine(
      await this.git(['log', '-1', '--format=%h%x09%s', 'FETCH_HEAD']),
    );
    const changelog = await this.git([
      'log',
      '--format=%h%x09%s',
      '-n',
      String(CHANGELOG_LIMIT),
      `${currentCommit}..FETCH_HEAD`,
    ]);
    return {
      checkedAt: new Date().toISOString(),
      cached: false,
      latest,
      behindBy,
      aheadBy,
      // Diverged (local commits the origin lacks) is not upgradable:
      // install.sh pulls --ff-only and would refuse — say so up front.
      upgradable: behindBy > 0 && aheadBy === 0,
      commits: changelog
        ? changelog.split('\n').map((line) => parseCommitLine(line))
        : [],
    };
  }

  private async git(args: string[], timeout = 10_000): Promise<string> {
    const result = await execa('git', args, {
      cwd: this.repoDir ?? undefined,
      timeout,
      reject: false,
    });
    if (result.exitCode !== 0) {
      const stderr = (result.stderr ?? '').trim();
      throw new Error(
        `git ${args[0]} failed: ${stderr.slice(0, 300) || `exit ${result.exitCode ?? 'unknown'}`}`,
      );
    }
    return result.stdout.trim();
  }
}

function parseCommitLine(line: string): { commit: string; title: string } {
  const tab = line.indexOf('\t');
  // A title containing a tab keeps its tail; a missing tab (never happens
  // with %h%x09%s) degrades to an empty title rather than a crash.
  if (tab === -1) return { commit: line, title: '' };
  return { commit: line.slice(0, tab), title: line.slice(tab + 1) };
}
