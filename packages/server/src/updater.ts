import { existsSync } from 'node:fs';
import { copyFile, mkdir, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type CheckUpgradeResponse,
  type GetUpgradeStatusResponse,
  type UpgradeRun,
  upgradeRunSchema,
} from '@dormice/shared';
import { execa } from 'execa';
import { httpError } from './http-error';
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
 *
 * Applying is a different animal: the daemon cannot upgrade itself (the
 * upgrade's last step restarts it, killing its own children), so apply()
 * hands install.sh to a systemd transient unit and steps aside — the unit
 * outlives the restart, tees its output where status() can read it, and
 * its name is the mutex against a double-click. The upgrade command line
 * is composed entirely from daemon-side paths: nothing from any request
 * ever reaches it.
 */

const CHECK_CACHE_MS = 3600_000;
/** Changelog preview cap — the wire is a preview, not the full history. */
const CHANGELOG_LIMIT = 50;
const FETCH_TIMEOUT_MS = 30_000;
const UNIT = 'dormice-upgrade';
/** Wire tail of the upgrade log — the full file stays on the host. */
const LOG_TAIL_BYTES = 16 * 1024;

/**
 * How the updater launches processes for apply/status (systemd-run,
 * systemctl). Injectable so tests exercise the launch path on hosts
 * without systemd; git stays un-injected — the tests run real git against
 * fixture repositories.
 */
export type RunCommand = (
  file: string,
  args: string[],
) => Promise<{ exitCode: number | undefined; stdout: string; stderr: string }>;

const defaultRun: RunCommand = async (file, args) => {
  const result = await execa(file, args, { reject: false });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

export interface UpdaterOptions {
  /**
   * Root of the git checkout the daemon runs from; null when there is
   * none (a dist copied around, tests) — checking is then honestly
   * impossible instead of quietly comparing the wrong repository.
   */
  repoDir: string | null;
  /** The identity baked into this build (version.ts). */
  build: BuildInfo | null;
  /** Where the upgrade unit writes status.json and its log: <DATA_DIR>/upgrade. */
  statusDir: string;
  /** One-click upgrade is a real install's move; the fake executor refuses. */
  executor: 'fake' | 'docker';
  run?: RunCommand;
}

type Check = NonNullable<CheckUpgradeResponse['check']>;

export class Updater {
  private readonly repoDir: string | null;
  private readonly build: BuildInfo | null;
  private readonly statusDir: string;
  private readonly executor: 'fake' | 'docker';
  private readonly run: RunCommand;
  private cache: { at: number; check: Check } | null = null;
  /** Probed once — every input (executor, checkout, systemd) is boot-stable. */
  private availabilityReason: string | null | undefined;

  constructor(options: UpdaterOptions) {
    this.repoDir = options.repoDir;
    this.build = options.build;
    this.statusDir = options.statusDir;
    this.executor = options.executor;
    this.run = options.run ?? defaultRun;
  }

  /** The identity baked into the running build — local, never networked. */
  get current(): BuildInfo | null {
    return this.build;
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

  /**
   * Launch the one-click upgrade: install.sh in a systemd transient unit.
   * The script is copied out of the tree first — its own first step is
   * `git pull`, which must not replace the file bash is reading. The
   * mirror choice is derived from the origin URL (an install done with
   * --mirror cn cloned through the mirror prefix), so no separate knob.
   */
  async apply(): Promise<void> {
    const reason = await this.availability();
    if (reason !== null) {
      throw httpError(400, `one-click upgrade unavailable: ${reason}`);
    }
    // availability() already refused a null repoDir; this narrows the type.
    if (this.repoDir === null) throw new Error('unreachable');
    await mkdir(this.statusDir, { recursive: true });
    const script = path.join(this.statusDir, 'install.sh');
    await copyFile(path.join(this.repoDir, 'deploy', 'install.sh'), script);
    const args = ['--status-dir', this.statusDir];
    if (await this.originUsesMirror()) args.push('--mirror', 'cn');
    const logFile = path.join(this.statusDir, 'upgrade.log');
    const command = `exec bash ${quote(script)} ${args.map(quote).join(' ')} >${quote(logFile)} 2>&1`;
    const launch = await this.run('systemd-run', [
      '--unit',
      UNIT,
      // Garbage-collect the unit when it ends, success or failure — the
      // name must be reusable for the next upgrade.
      '--collect',
      '--description',
      'Dormice self-upgrade (install.sh)',
      '/bin/bash',
      '-c',
      command,
    ]);
    if (launch.exitCode !== 0) {
      const stderr = launch.stderr.trim();
      // The unit name is the mutex: systemd refuses a second one.
      if (stderr.includes('already exists')) {
        throw httpError(
          409,
          'an upgrade is already running — wait for it to finish (systemd unit dormice-upgrade)',
        );
      }
      throw httpError(
        500,
        `failed to launch the upgrade: ${stderr.slice(0, 300) || 'systemd-run gave no reason'}`,
      );
    }
  }

  /**
   * The execution window: unit liveness from systemd (never from the
   * status file's claim), the last run's report, and the log tail. A
   * status file stuck at "running" with no live unit is adjudicated into
   * an honest failure — an upgrade that died without reporting must not
   * look like one that never ends.
   */
  async status(): Promise<GetUpgradeStatusResponse> {
    const reason = await this.availability();
    const running = await this.unitActive();
    let last = await this.readRun();
    if (last !== null && last.state === 'running' && !running) {
      last = {
        ...last,
        state: 'failed',
        error:
          'the upgrade process died without reporting an outcome — see the log and journalctl -u dormice-upgrade',
      };
    }
    return {
      available: reason === null,
      unavailableReason: reason,
      running,
      last,
      log: await this.readLogTail(),
    };
  }

  private async availability(): Promise<string | null> {
    if (this.availabilityReason === undefined) {
      this.availabilityReason = await this.probeAvailability();
    }
    return this.availabilityReason;
  }

  private async probeAvailability(): Promise<string | null> {
    if (this.executor !== 'docker') {
      return 'one-click upgrade is for a real install (docker executor) — this daemon runs the fake executor';
    }
    if (this.repoDir === null) {
      return 'the daemon does not run from a git checkout';
    }
    if (!existsSync(path.join(this.repoDir, 'deploy', 'install.sh'))) {
      return 'deploy/install.sh is missing from the checkout';
    }
    // Presence of systemd-run covers the platform question too — a
    // non-systemd host simply does not have it.
    const probe = await this.run('systemd-run', ['--version']);
    if (probe.exitCode !== 0) {
      return 'systemd-run is not available — one-click upgrade needs a systemd host';
    }
    return null;
  }

  private async originUsesMirror(): Promise<boolean> {
    try {
      const url = await this.git(['remote', 'get-url', 'origin']);
      return url.includes('ghfast.top');
    } catch {
      return false;
    }
  }

  private async unitActive(): Promise<boolean> {
    const result = await this.run('systemctl', [
      'is-active',
      '--quiet',
      `${UNIT}.service`,
    ]);
    return result.exitCode === 0;
  }

  private async readRun(): Promise<UpgradeRun | null> {
    try {
      const raw = await readFile(
        path.join(this.statusDir, 'status.json'),
        'utf8',
      );
      const parsed = upgradeRunSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      // Missing or torn file: no report is a valid answer, not a crash.
      return null;
    }
  }

  private async readLogTail(): Promise<string | null> {
    try {
      const file = path.join(this.statusDir, 'upgrade.log');
      const size = (await stat(file)).size;
      const want = Math.min(size, LOG_TAIL_BYTES);
      const handle = await open(file, 'r');
      try {
        const { buffer, bytesRead } = await handle.read({
          buffer: Buffer.alloc(want),
          position: size - want,
        });
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  private async git(args: string[], timeout = 10_000): Promise<string> {
    const result = await execa('git', args, {
      cwd: this.repoDir ?? undefined,
      timeout,
      reject: false,
    });
    if (result.exitCode !== 0) {
      // A hung fetch (unreachable mirror, packet-dropping middlebox) is the
      // most common failure here — name it instead of "exit unknown".
      if (result.timedOut) {
        throw new Error(`git ${args[0]} timed out after ${timeout / 1000}s`);
      }
      const stderr = (result.stderr ?? '').trim();
      throw new Error(
        `git ${args[0]} failed: ${stderr.slice(0, 300) || `exit ${result.exitCode ?? 'unknown'}`}`,
      );
    }
    return result.stdout.trim();
  }
}

/** Single-quote for the shell: the one metacharacter inside is `'` itself. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function parseCommitLine(line: string): { commit: string; title: string } {
  const tab = line.indexOf('\t');
  // A title containing a tab keeps its tail; a missing tab (never happens
  // with %h%x09%s) degrades to an empty title rather than a crash.
  if (tab === -1) return { commit: line, title: '' };
  return { commit: line.slice(0, tab), title: line.slice(tab + 1) };
}
