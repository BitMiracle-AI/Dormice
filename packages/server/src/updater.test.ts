import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkUpgradeResponseSchema } from '@dormice/shared';
import { execaSync } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';
import { Updater } from './updater';
import type { BuildInfo } from './version';

// The updater against real git: a fixture origin, a clone that plays the
// installed daemon, and builds pinned to specific commits. Everything is
// local paths — the network is never touched.

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

beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'dormice-updater-'));
  origin = path.join(root, 'origin');
  clone = path.join(root, 'clone');
  execaSync('git', ['init', '-q', '-b', 'main', origin]);
  commit(origin, 'first');
  commit(origin, 'second');
  execaSync('git', ['clone', '-q', origin, clone]);
  installedBuild = buildAt(clone);
});

describe('Updater.check', () => {
  it('reports up to date when the build matches origin main', async () => {
    const updater = new Updater({ repoDir: clone, build: installedBuild });
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
    const updater = new Updater({ repoDir: clone, build: installedBuild });
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
    const updater = new Updater({ repoDir: clone, build: installedBuild });
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
      const updater = new Updater({ repoDir: clone, build: buildAt(clone) });
      const answer = await updater.check();
      expect(answer.checkError).toBeNull();
      expect(answer.check?.aheadBy).toBe(1);
      expect(answer.check?.upgradable).toBe(false);
    } finally {
      execaSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: clone });
    }
  });

  it('is honest without a checkout, without a build identity, and on a dead remote', async () => {
    const noRepo = new Updater({ repoDir: null, build: installedBuild });
    expect((await noRepo.check()).checkError).toMatch(/git checkout/);

    const noBuild = new Updater({ repoDir: clone, build: null });
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
    const deadRemote = new Updater({ repoDir: broken, build: buildAt(broken) });
    const dead = await deadRemote.check();
    expect(dead.check).toBeNull();
    expect(dead.checkError).toMatch(/fetch failed/);
  });
});
