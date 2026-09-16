import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkUpgradeResponseSchema,
  getUpgradeStatusResponseSchema,
} from '@dormice/shared';
import { execaSync } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeExecutorUnavailable } from './app';
import { type RunCommand, Updater, type UpdaterOptions } from './updater';
import type { BuildInfo } from './version';

// The updater against real git: a fixture origin, a clone that plays the
// installed daemon, and builds pinned to specific commits. Everything is
// local paths — the network is never touched. systemd-run/systemctl are
// injected (RunCommand), so the launch path runs on any host.

function git(cwd: string, ...args: string[]): string {
  return execaSync('git', args, { cwd }).stdout.trim();
}

function commit(cwd: string, title: string): { commit: string; title: string } {
  execaSync(
    'git',
    [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=test',
      'commit',
      '--allow-empty',
      '-m',
      title,
    ],
    { cwd },
  );
  return { commit: git(cwd, 'rev-parse', '--short', 'HEAD'), title };
}

function buildAt(repo: string): BuildInfo {
  return {
    commit: git(repo, 'rev-parse', '--short', 'HEAD'),
    title: git(repo, 'log', '-1', '--format=%s'),
    committedAt: new Date(git(repo, 'log', '-1', '--format=%cI')).toISOString(),
  };
}

let origin: string;
let clone: string;
/** The identity of the clone's HEAD at "install time". */
let installedBuild: BuildInfo;

/** The systemd side, happy to do anything — apply tests override pieces. */
const okRun: RunCommand = async () => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
});

function updaterFor(overrides: Partial<UpdaterOptions> = {}): Updater {
  return new Updater({
    repoDir: clone,
    build: installedBuild,
    statusDir: mkdtempSync(path.join(tmpdir(), 'dormice-status-')),
    run: okRun,
    ...overrides,
  });
}

beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'dormice-updater-'));
  origin = path.join(root, 'origin');
  clone = path.join(root, 'clone');
  execaSync('git', ['init', '-q', '-b', 'main', origin]);
  // The tree carries a stand-in installer: apply() launches the
  // deploy/install.sh of the build it installs, fetched from the origin.
  mkdirSync(path.join(origin, 'deploy'));
  writeFileSync(path.join(origin, 'deploy', 'install.sh'), '#!/bin/bash\n');
  execaSync('git', ['add', '-A'], { cwd: origin });
  commit(origin, 'first');
  commit(origin, 'second');
  execaSync('git', ['clone', '-q', origin, clone]);
  installedBuild = buildAt(clone);
});

describe('Updater.check', () => {
  it("reports up to date when the build matches the tracked branch's head", async () => {
    const updater = updaterFor();
    const answer = await updater.check();
    const parsed = checkUpgradeResponseSchema.parse(answer);
    expect(parsed.checkError).toBeNull();
    expect(parsed.current).toEqual(installedBuild);
    expect(parsed.check).toMatchObject({
      behindBy: 0,
      aheadBy: 0,
      upgradable: false,
      cached: false,
      commits: [],
    });
    expect(parsed.check?.latest.commit).toBe(installedBuild.commit);
  });

  it('reports behind commits newest first and adjudicates upgradable', async () => {
    const third = commit(origin, 'third');
    const fourth = commit(origin, 'fourth');
    const updater = updaterFor();
    const answer = await updater.check();
    expect(answer.checkError).toBeNull();
    expect(answer.check).toMatchObject({
      behindBy: 2,
      aheadBy: 0,
      upgradable: true,
      latest: fourth,
    });
    expect(answer.check?.commits).toEqual([fourth, third]);
  });

  it('serves the second answer from cache and refetches on force', async () => {
    const updater = updaterFor();
    const first = await updater.check();
    expect(first.check?.cached).toBe(false);
    const behindThen = first.check?.behindBy ?? 0;

    commit(origin, 'landed after the first check');
    const second = await updater.check();
    expect(second.check?.cached).toBe(true);
    expect(second.check?.behindBy).toBe(behindThen);

    const forced = await updater.check(true);
    expect(forced.check?.cached).toBe(false);
    expect(forced.check?.behindBy).toBe(behindThen + 1);
  });

  it('reports divergence as not upgradable', async () => {
    // A local commit origin lacks: install.sh pulls --ff-only and would
    // refuse, so the check must say diverged instead of promising an
    // upgrade that cannot apply.
    commit(clone, 'local only');
    try {
      const updater = updaterFor({ build: buildAt(clone) });
      const answer = await updater.check();
      expect(answer.checkError).toBeNull();
      expect(answer.check?.aheadBy).toBe(1);
      expect(answer.check?.upgradable).toBe(false);
    } finally {
      execaSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: clone });
    }
  });

  it('follows the branch the checkout tracks, not main', async () => {
    // A checkout on a series branch (the test machine's shape between
    // cuts): what check() compares against, what install.sh pulls and
    // whose install.sh apply() runs must be the same ref, and that ref is
    // the branch's upstream — main would read this build as ahead.
    execaSync('git', ['checkout', '-q', '-b', 'series'], { cwd: origin });
    const onSeries = commit(origin, 'on the series branch');
    execaSync('git', ['checkout', '-q', 'main'], { cwd: origin });
    const series = mkdtempSync(path.join(tmpdir(), 'dormice-series-'));
    execaSync('git', ['clone', '-q', '-b', 'series', origin, series]);
    const updater = updaterFor({ repoDir: series, build: buildAt(series) });
    const upToDate = await updater.check();
    expect(upToDate.checkError).toBeNull();
    expect(upToDate.check).toMatchObject({
      behindBy: 0,
      aheadBy: 0,
      latest: onSeries,
    });

    execaSync('git', ['checkout', '-q', 'series'], { cwd: origin });
    const later = commit(origin, 'later on the series branch');
    execaSync('git', ['checkout', '-q', 'main'], { cwd: origin });
    const behind = await updater.check(true);
    expect(behind.check).toMatchObject({
      behindBy: 1,
      aheadBy: 0,
      upgradable: true,
      latest: later,
    });
  });

  it('is honest without a checkout, without a build identity, on an untracked branch and on a dead remote', async () => {
    const noRepo = updaterFor({ repoDir: null });
    expect((await noRepo.check()).checkError).toMatch(/git checkout/);

    const noBuild = updaterFor({ build: null });
    const answer = await noBuild.check();
    expect(answer.current).toBeNull();
    expect(answer.checkError).toMatch(/version identity/);

    const broken = mkdtempSync(path.join(tmpdir(), 'dormice-broken-'));
    execaSync('git', ['init', '-q', '-b', 'main', broken]);
    commit(broken, 'orphan');
    execaSync(
      'git',
      ['remote', 'add', 'origin', path.join(broken, 'does-not-exist')],
      { cwd: broken },
    );
    // A remote, but a branch that tracks nothing: there is no ref to
    // compare against or to pull along, and one-click says so too.
    const untracked = updaterFor({ repoDir: broken, build: buildAt(broken) });
    expect((await untracked.check()).checkError).toMatch(/tracks no upstream/);
    expect(await untracked.availability()).toMatch(/tracks no upstream/);

    execaSync('git', ['config', 'branch.main.remote', 'origin'], {
      cwd: broken,
    });
    execaSync('git', ['config', 'branch.main.merge', 'refs/heads/main'], {
      cwd: broken,
    });
    const deadRemote = updaterFor({ repoDir: broken, build: buildAt(broken) });
    const dead = await deadRemote.check();
    expect(dead.check).toBeNull();
    expect(dead.checkError).toMatch(/fetch failed/);
    // One-click is available on paper (the branch tracks a remote), and
    // the launch fails honestly when the installer cannot be fetched.
    expect(await deadRemote.availability()).toBeNull();
    await expect(deadRemote.apply()).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining('could not fetch the installer'),
    });

    const detached = mkdtempSync(path.join(tmpdir(), 'dormice-detached-'));
    execaSync('git', ['clone', '-q', origin, detached]);
    execaSync('git', ['checkout', '-q', '--detach'], { cwd: detached });
    const offBranch = updaterFor({
      repoDir: detached,
      build: buildAt(detached),
    });
    expect(await offBranch.availability()).toMatch(/detached HEAD/);
    await expect(offBranch.apply()).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('Updater.apply and status', () => {
  it("refuses one-click for the caller's own reason (the daemon's fake executor) and without a checkout; availability() is the same word the check-in reports", async () => {
    const fake = updaterFor({
      unavailable: fakeExecutorUnavailable('fake'),
    });
    await expect(fake.apply()).rejects.toMatchObject({ statusCode: 400 });
    const status = await fake.status();
    expect(status.available).toBe(false);
    expect(status.unavailableReason).toMatch(/fake executor/);
    expect(await fake.availability()).toBe(status.unavailableReason);
    expect(fakeExecutorUnavailable('docker')).toBeUndefined();

    const noRepo = updaterFor({ repoDir: null });
    expect((await noRepo.status()).unavailableReason).toMatch(/git checkout/);
    expect(await updaterFor().availability()).toBeNull();
  });

  it('launches install.sh in a transient unit built from daemon-side paths only', async () => {
    const statusDir = mkdtempSync(path.join(tmpdir(), 'dormice-status-'));
    const calls: Array<{ file: string; args: string[] }> = [];
    const updater = updaterFor({
      statusDir,
      run: async (file, args) => {
        calls.push({ file, args });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    await updater.apply();

    const launch = calls.at(-1);
    expect(launch?.file).toBe('systemd-run');
    expect(launch?.args).toContain('--unit');
    expect(launch?.args).toContain('dormice-upgrade');
    expect(launch?.args).toContain('--collect');
    const command = launch?.args.at(-1) ?? '';
    // A file in the status dir, not the tree's (git pull would replace it
    // mid-read), reporting into the status dir, output tee'd next to it.
    expect(command).toContain(`${statusDir}/install.sh`);
    expect(command).toContain('--status-dir');
    expect(command).toContain('upgrade.log');
    // A local-path origin is not the cn mirror.
    expect(command).not.toContain('--mirror');
    expect(existsSync(path.join(statusDir, 'install.sh'))).toBe(true);
  });

  it("runs the installer of the build being installed, not the tree's copy", async () => {
    // The origin moves on with a changed installer: the upgrade must run
    // that one — it alone knows the host-side steps its build needs — and
    // the tree, still at the old build, is not where it comes from.
    const newInstaller = '#!/bin/bash\necho the new installer\n';
    writeFileSync(path.join(origin, 'deploy', 'install.sh'), newInstaller);
    execaSync('git', ['add', '-A'], { cwd: origin });
    commit(origin, 'a changed installer');
    const statusDir = mkdtempSync(path.join(tmpdir(), 'dormice-status-'));
    const updater = updaterFor({ statusDir });
    await updater.apply();
    expect(readFileSync(path.join(statusDir, 'install.sh'), 'utf8')).toBe(
      newInstaller,
    );
    expect(readFileSync(path.join(clone, 'deploy', 'install.sh'), 'utf8')).toBe(
      '#!/bin/bash\n',
    );
  });

  it('passes --mirror cn when the origin was cloned through the mirror', async () => {
    const mirrored = mkdtempSync(path.join(tmpdir(), 'dormice-mirrored-'));
    execaSync('git', ['clone', '-q', origin, mirrored]);
    // The remote's URL as an install with --mirror cn writes it; git is
    // told to reach the fixture origin in its place (url.insteadOf), so
    // the fetch apply() does stays off the network. The mirror is judged
    // from the URL as configured, not as rewritten.
    const mirrorUrl =
      'https://ghfast.top/https://github.com/BitMiracle-AI/Dormice.git';
    execaSync('git', ['remote', 'set-url', 'origin', mirrorUrl], {
      cwd: mirrored,
    });
    execaSync('git', ['config', `url.${origin}.insteadOf`, mirrorUrl], {
      cwd: mirrored,
    });
    const calls: string[] = [];
    const updater = updaterFor({
      repoDir: mirrored,
      run: async (_file, args) => {
        calls.push(args.at(-1) ?? '');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    await updater.apply();
    expect(calls.at(-1)).toContain("--mirror' 'cn'");
  });

  it('maps a refused launch with a live unit to an honest 409', async () => {
    // The refusal wording is systemd 255's, verbatim from the real machine
    // — the adjudication must not depend on it: the unit's liveness is
    // what makes this a "someone is already upgrading", not the prose.
    // Liveness is systemctl list-units listing the unit (its real line).
    const updater = updaterFor({
      run: async (file, args) =>
        file === 'systemctl'
          ? {
              exitCode: 0,
              stdout:
                'dormice-upgrade.service loaded active running Dormice upgrade (install.sh)\n',
              stderr: '',
            }
          : args[0] === '--version'
            ? { exitCode: 0, stdout: '', stderr: '' }
            : {
                exitCode: 1,
                stdout: '',
                stderr:
                  'Failed to start transient service unit: Unit dormice-upgrade.service was already loaded or has a fragment file.',
              },
    });
    await expect(updater.apply()).rejects.toMatchObject({ statusCode: 409 });
  });

  it('maps a failed launch with no live unit to a 500 carrying stderr', async () => {
    const updater = updaterFor({
      run: async (file, args) =>
        args[0] === '--version'
          ? { exitCode: 0, stdout: '', stderr: '' }
          : file === 'systemctl'
            ? // list-units lists nothing: the unit is not in memory.
              { exitCode: 0, stdout: '', stderr: '' }
            : {
                exitCode: 1,
                stdout: '',
                stderr: 'Interactive authentication required.',
              },
    });
    await expect(updater.apply()).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining('Interactive authentication required'),
    });
  });

  it('adjudicates a dead runner into a failure and tails the log', async () => {
    const statusDir = mkdtempSync(path.join(tmpdir(), 'dormice-status-'));
    writeFileSync(
      path.join(statusDir, 'status.json'),
      JSON.stringify({
        state: 'running',
        startedAt: '2026-07-15T08:00:00Z',
        finishedAt: null,
        fromCommit: 'abc1234',
        toCommit: null,
        error: null,
      }),
    );
    writeFileSync(path.join(statusDir, 'upgrade.log'), '==> build\nboom\n');
    // systemd-run answers the availability probe; systemctl lists no such
    // unit — the "running" claim in the file is a dead process.
    const updater = updaterFor({
      statusDir,
      run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    const status = getUpgradeStatusResponseSchema.parse(await updater.status());
    expect(status.available).toBe(true);
    expect(status.running).toBe(false);
    expect(status.last?.state).toBe('failed');
    expect(status.last?.error).toMatch(/died without reporting/);
    expect(status.log).toContain('boom');
  });

  it('reports a finished run exactly as install.sh wrote it', async () => {
    const statusDir = mkdtempSync(path.join(tmpdir(), 'dormice-status-'));
    const run = {
      state: 'rolled-back',
      startedAt: '2026-07-15T08:00:00Z',
      finishedAt: '2026-07-15T08:05:00Z',
      fromCommit: 'abc1234',
      toCommit: 'def5678',
      error: 'failed during: build',
    };
    writeFileSync(path.join(statusDir, 'status.json'), JSON.stringify(run));
    const updater = updaterFor({
      statusDir,
      run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    const status = await updater.status();
    expect(status.last).toEqual(run);
    // No run ever happened elsewhere: last is null, not invented.
    const fresh = updaterFor();
    expect((await fresh.status()).last).toBeNull();
  });
});
