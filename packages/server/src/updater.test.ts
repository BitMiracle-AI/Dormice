import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkUpgradeResponseSchema,
  getUpgradeStatusResponseSchema,
} from '@dormice/shared';
import { execaSync } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';
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
    executor: 'docker',
    run: okRun,
    ...overrides,
  });
}

beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'dormice-updater-'));
  origin = path.join(root, 'origin');
  clone = path.join(root, 'clone');
  execaSync('git', ['init', '-q', '-b', 'main', origin]);
  // The tree carries a stand-in installer: apply() copies and launches
  // deploy/install.sh, and availability checks it exists.
  mkdirSync(path.join(origin, 'deploy'));
  writeFileSync(path.join(origin, 'deploy', 'install.sh'), '#!/bin/bash\n');
  execaSync('git', ['add', '-A'], { cwd: origin });
  commit(origin, 'first');
  commit(origin, 'second');
  execaSync('git', ['clone', '-q', origin, clone]);
  installedBuild = buildAt(clone);
});

describe('Updater.check', () => {
  it('reports up to date when the build matches origin main', async () => {
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

  it('is honest without a checkout, without a build identity, and on a dead remote', async () => {
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
    const deadRemote = updaterFor({ repoDir: broken, build: buildAt(broken) });
    const dead = await deadRemote.check();
    expect(dead.check).toBeNull();
    expect(dead.checkError).toMatch(/fetch failed/);
  });
});

describe('Updater.apply and status', () => {
  it('refuses one-click on the fake executor and without a checkout', async () => {
    const fake = updaterFor({ executor: 'fake' });
    await expect(fake.apply()).rejects.toMatchObject({ statusCode: 400 });
    const status = await fake.status();
    expect(status.available).toBe(false);
    expect(status.unavailableReason).toMatch(/fake executor/);

    const noRepo = updaterFor({ repoDir: null });
    expect((await noRepo.status()).unavailableReason).toMatch(/git checkout/);
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
    // The copy, not the tree's file (git pull would replace it mid-read),
    // reporting into the status dir, output tee'd next to it.
    expect(command).toContain(`${statusDir}/install.sh`);
    expect(command).toContain('--status-dir');
    expect(command).toContain('upgrade.log');
    // A local-path origin is not the cn mirror.
    expect(command).not.toContain('--mirror');
    expect(existsSync(path.join(statusDir, 'install.sh'))).toBe(true);
  });

  it('passes --mirror cn when the origin was cloned through the mirror', async () => {
    const mirrored = mkdtempSync(path.join(tmpdir(), 'dormice-mirrored-'));
    execaSync('git', ['clone', '-q', origin, mirrored]);
    execaSync(
      'git',
      [
        'remote',
        'set-url',
        'origin',
        'https://ghfast.top/https://github.com/BitMiracle-AI/Dormice.git',
      ],
      { cwd: mirrored },
    );
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

  it('maps a live unit to an honest 409', async () => {
    const updater = updaterFor({
      run: async (_file, args) =>
        args[0] === '--version'
          ? { exitCode: 0, stdout: '', stderr: '' }
          : {
              exitCode: 1,
              stdout: '',
              stderr:
                'Failed to start transient service unit: Unit dormice-upgrade.service already exists.',
            },
    });
    await expect(updater.apply()).rejects.toMatchObject({ statusCode: 409 });
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
    // systemd-run answers the availability probe; systemctl says the unit
    // is not active — the "running" claim in the file is a dead process.
    const updater = updaterFor({
      statusDir,
      run: async (file) =>
        file === 'systemctl'
          ? { exitCode: 3, stdout: '', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
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
      run: async (file) =>
        file === 'systemctl'
          ? { exitCode: 3, stdout: '', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
    });
    const status = await updater.status();
    expect(status.last).toEqual(run);
    // No run ever happened elsewhere: last is null, not invented.
    const fresh = updaterFor();
    expect((await fresh.status()).last).toBeNull();
  });
});
