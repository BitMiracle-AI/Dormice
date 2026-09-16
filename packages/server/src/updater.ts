import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
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
 * A process's own upgrade window — the daemon's, and since the fourth cut
 * the gateway's (imported through the `@dormice/server/updater` subpath;
 * the gateway's machine is upgraded by the same install.sh, and its
 * process launches it the same way). Versions are git commits
 * (trunk-based, no release tags yet), and the question "is a newer
 * Dormice available?" is answered by comparing the commit baked into this
 * build against the head of the branch the checkout tracks — origin/main
 * for every install the installer made — fetched through the checkout's
 * own remote, so an install done with `--mirror cn` (whose clone URL
 * carries the mirror prefix) checks through the same mirror for free.
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
 * its name is the mutex against a double-click. The install.sh it hands
 * over is the one of the build being installed, read from the fetched
 * head (`git show FETCH_HEAD:deploy/install.sh`) into the status
 * directory — not the tree's copy, which is the build being replaced: an
 * upgrade is "bring this machine to that commit", and only that commit's
 * installer knows the host-side steps it needs (a sysctl floor, a runtime
 * flag, a new unit). Run with the old script, twice in production the code
 * arrived and the host-side step did not, until someone re-ran the new
 * installer by hand (2026-09-01 --allow-suid, 2026-09-09 the inotify
 * floor). The upgrade command line is composed entirely from daemon-side
 * paths: nothing from any request ever reaches it.
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
  /**
   * The caller's own reason one-click is off, when it has one: the daemon
   * says so on the fake executor (a real install's move, not a test
   * double's), the gateway on an in-memory database. Checked first; the
   * checkout, install.sh and systemd-run probes follow.
   */
  unavailable?: string;
  run?: RunCommand;
}

type Check = NonNullable<CheckUpgradeResponse['check']>;

export class Updater {
  private readonly repoDir: string | null;
  private readonly build: BuildInfo | null;
  private readonly statusDir: string;
  private readonly unavailable: string | undefined;
  private readonly run: RunCommand;
  private cache: { at: number; check: Check } | null = null;
  /** Probed once — every input (executor, checkout, systemd) is boot-stable. */
  private availabilityReason: string | null | undefined;

  constructor(options: UpdaterOptions) {
    this.repoDir = options.repoDir;
    this.build = options.build;
    this.statusDir = options.statusDir;
    this.unavailable = options.unavailable;
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
          'the process does not run from a git checkout — nothing to compare against',
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

  /**
   * The line this checkout follows: the remote and branch its HEAD tracks
   * — the one ref for the three things that must agree: what check()
   * compares against, what install.sh's `git pull --ff-only` brings, and
   * whose install.sh apply() runs. Read the way git reads it for pull
   * (branch.<name>.remote and .merge), so a checkout on a series branch
   * follows that branch and a clone of main follows main. Throws, in
   * words, for a detached HEAD or a branch that tracks nothing.
   */
  private async upstream(): Promise<{ remote: string; branch: string }> {
    let head: string;
    try {
      head = await this.git(['symbolic-ref', '--short', '--quiet', 'HEAD']);
    } catch {
      throw new Error(
        'the checkout is on a detached HEAD, not a branch — install.sh pulls --ff-only along a branch that tracks its remote',
      );
    }
    let remote: string;
    let merge: string;
    try {
      remote = await this.git(['config', '--get', `branch.${head}.remote`]);
      merge = await this.git(['config', '--get', `branch.${head}.merge`]);
    } catch {
      throw new Error(
        `branch ${head} tracks no upstream — install.sh pulls --ff-only from the branch it tracks (git branch --set-upstream-to=origin/main, on an install of main)`,
      );
    }
    return { remote, branch: merge.replace(/^refs\/heads\//, '') };
  }

  /** The head of the tracked branch, into FETCH_HEAD — written by every fetch regardless of the clone's refspec configuration. */
  private async fetchUpstream(): Promise<void> {
    const { remote, branch } = await this.upstream();
    await this.git(['fetch', '--quiet', remote, branch], FETCH_TIMEOUT_MS);
  }

  private async compare(currentCommit: string): Promise<Check> {
    await this.fetchUpstream();
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
   * The script is the one of the build being installed — the tracked
   * branch's head, fetched now, `git show`n into the status directory
   * (the module comment has why); outside the tree, because the script's
   * own first step is `git pull`, which must not replace the file bash is
   * reading. A commit that lands between this fetch and that pull would
   * put the tree one commit past the script — seconds of drift at most,
   * and the node's next check-in reports the tree's build. The mirror
   * choice is derived from the remote's URL (an install done with
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
    try {
      await this.fetchUpstream();
      // execa strips the blob's final newline; put it back.
      const content = await this.git(['show', 'FETCH_HEAD:deploy/install.sh']);
      await writeFile(script, `${content}\n`);
    } catch (error) {
      throw httpError(
        500,
        `could not fetch the installer of the build to install: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const args = ['--status-dir', this.statusDir];
    if (await this.remoteUsesMirror()) args.push('--mirror', 'cn');
    const logFile = path.join(this.statusDir, 'upgrade.log');
    const command = `exec bash ${quote(script)} ${args.map(quote).join(' ')} >${quote(logFile)} 2>&1`;
    const launch = await this.run('systemd-run', [
      '--unit',
      UNIT,
      // Garbage-collect the unit when it ends, success or failure — the
      // name must be reusable for the next upgrade.
      '--collect',
      '--description',
      'Dormice upgrade (install.sh)',
      '/bin/bash',
      '-c',
      command,
    ]);
    if (launch.exitCode !== 0) {
      // The unit name is the mutex, but systemd phrases the refusal more
      // than one way ("already exists"; "was already loaded or has a
      // fragment file" on systemd 255, caught on real hardware) — so ask
      // systemd whether the unit is alive instead of parsing prose.
      if (await this.unitActive()) {
        throw httpError(
          409,
          'an upgrade is already running — wait for it to finish (systemd unit dormice-upgrade)',
        );
      }
      const stderr = launch.stderr.trim();
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

  /**
   * Why one-click is off, or null when it is on — probed once (every
   * input is boot-stable). Public for the node's check-in, which reports
   * it to the gateway: the fleet upgrade rolls over the nodes that can
   * upgrade themselves and names the rest with this reason.
   */
  async availability(): Promise<string | null> {
    if (this.availabilityReason === undefined) {
      this.availabilityReason = await this.probeAvailability();
    }
    return this.availabilityReason;
  }

  private async probeAvailability(): Promise<string | null> {
    if (this.unavailable !== undefined) {
      return this.unavailable;
    }
    if (this.repoDir === null) {
      return 'the process does not run from a git checkout';
    }
    // The branch to pull along and to take the installer from must be
    // known before a node reports it can upgrade itself: told without one,
    // it would fail the launch and read stuck twenty minutes on.
    try {
      await this.upstream();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    // Presence of systemd-run covers the platform question too — a
    // non-systemd host simply does not have it.
    const probe = await this.run('systemd-run', ['--version']);
    if (probe.exitCode !== 0) {
      return 'systemd-run is not available — one-click upgrade needs a systemd host';
    }
    return null;
  }

  /** Whether the tracked remote was cloned through the mainland mirror prefix — its configured URL as written, before any url.insteadOf rewrite git applies when fetching. */
  private async remoteUsesMirror(): Promise<boolean> {
    try {
      const { remote } = await this.upstream();
      const url = await this.git(['config', '--get', `remote.${remote}.url`]);
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
    // As git printed it, less the final newline execa strips: every caller
    // reads whole lines, and the one that reads a file (`git show` in
    // apply) puts that newline back.
    return result.stdout;
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
