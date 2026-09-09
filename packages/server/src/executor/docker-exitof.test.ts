import { type ChildProcess, spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type Docker from 'dockerode';
import { afterEach, describe, expect, it } from 'vitest';
import { cgroupCounter, containerName, DockerExecutor } from './docker';

/**
 * exitOf's one piece of logic the contract cannot pin: the lag between a
 * sandbox's death and Docker recording it. The docker-only contract
 * questions kill real sandboxes and check the answer, but whether they land
 * inside the lag is up to the runtime that day (measured 3/3 for OOM, 2/5
 * for the pids cap). Here the Docker client is a stub, so each branch is
 * reached on purpose: a running shell that is really alive, one the kernel
 * has OOM-flagged, one whose init is a zombie, one whose init is gone, and
 * one that never stops running however long we wait.
 */

interface ShellState {
  status: string;
  oomKilled: boolean;
  exitCode: number;
  pid: number;
  finishedAt: string;
}

/** A Docker client that answers inspect from `shell` and records wait calls. */
function stubDocker(
  shell: ShellState | null,
  onWait: (opts: {
    condition?: string;
    abortSignal?: AbortSignal;
  }) => Promise<unknown>,
) {
  const calls: { inspected: string[]; waited: string[] } = {
    inspected: [],
    waited: [],
  };
  const docker = {
    getContainer(ref: string) {
      return {
        async inspect() {
          calls.inspected.push(ref);
          if (shell === null) {
            throw Object.assign(new Error('no such container'), {
              statusCode: 404,
            });
          }
          return {
            Id: 'c0ffee',
            State: {
              Status: shell.status,
              OOMKilled: shell.oomKilled,
              ExitCode: shell.exitCode,
              Pid: shell.pid,
              FinishedAt: shell.finishedAt,
            },
            HostConfig: { NanoCpus: 1e9, PidsLimit: 4096 },
          };
        },
        wait(opts: { condition?: string; abortSignal?: AbortSignal }) {
          calls.waited.push(ref);
          return onWait(opts);
        },
      };
    },
  };
  return { docker: docker as unknown as Docker, calls };
}

function executor(docker: Docker, cgroupRoot?: string): DockerExecutor {
  return new DockerExecutor(
    {
      baseImage: 'unused',
      dataDir: '/nonexistent',
      resources: () => ({ diskSizeGb: 1, cpus: 1, memoryGb: 1 }),
      pidsLimit: () => 4096,
      reclaimTimeoutSeconds: 1,
    },
    docker,
    cgroupRoot,
  );
}

/**
 * A staged cgroup directory for the stub container 'c0ffee': the kernel's
 * event files as it writes them. Returns the root to hand the executor.
 */
async function stagedCgroup(memoryEvents: string, pidsEvents: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'dormice-cgroup-'));
  const dir = path.join(root, 'system.slice', 'docker-c0ffee.scope');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'memory.events'), memoryEvents);
  await writeFile(path.join(dir, 'pids.events'), pidsEvents);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const QUIET_MEMORY =
  'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n';
const QUIET_PIDS = 'max 0\n';

const NEVER = () => new Promise<never>(() => {});
const ABORTED = () =>
  Promise.reject(
    Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    }),
  );

const linux = process.platform === 'linux';

/**
 * A real zombie: `true &` forks a subshell that exits at once, and the shell
 * then execs into sleep without ever reaping it — the same "pid (sh) Z"
 * shape a dead sentry shows Docker's State.Pid in.
 */
async function spawnZombie(): Promise<{ pid: number; parent: ChildProcess }> {
  const parent = spawn('sh', ['-c', 'true & exec sleep 30']);
  for (let i = 0; i < 100; i++) {
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try {
        stat = await readFile(`/proc/${entry}/stat`, 'utf8');
      } catch {
        continue;
      }
      const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(ppid) === parent.pid && state === 'Z') {
        return { pid: Number(entry), parent };
      }
    }
    await sleep(20);
  }
  parent.kill('SIGKILL');
  throw new Error('no zombie appeared under the helper shell');
}

describe('DockerExecutor.exitOf across the runtime lag', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it('a running shell whose init is alive is alive: null, and no wait', async () => {
    const { docker, calls } = stubDocker(
      {
        status: 'running',
        oomKilled: false,
        exitCode: 0,
        pid: process.pid,
        finishedAt: '0001-01-01T00:00:00Z',
      },
      NEVER,
    );
    expect(await executor(docker).exitOf('sbx')).toBeNull();
    expect(calls.inspected).toEqual([containerName('sbx')]);
    expect(calls.waited).toEqual([]);
  });

  it('paused, stopped and absent shells are read straight, never waited on', async () => {
    const paused = stubDocker(
      {
        status: 'paused',
        oomKilled: true,
        exitCode: 0,
        pid: 1,
        finishedAt: '0001-01-01T00:00:00Z',
      },
      NEVER,
    );
    expect(await executor(paused.docker).exitOf('sbx')).toBeNull();
    expect(paused.calls.waited).toEqual([]);

    const stopped = stubDocker(
      {
        status: 'exited',
        oomKilled: true,
        exitCode: 137,
        pid: 0,
        finishedAt: '2026-09-09T02:16:43.578819966Z',
      },
      NEVER,
    );
    // Nanoseconds in, the ledger's millisecond ISO out.
    expect(await executor(stopped.docker).exitOf('sbx')).toEqual({
      exitCode: 137,
      oomKilled: true,
      runtimeDied: false,
      finishedAt: '2026-09-09T02:16:43.578Z',
    });
    expect(stopped.calls.waited).toEqual([]);

    const absent = stubDocker(null, NEVER);
    expect(await executor(absent.docker).exitOf('sbx')).toBeNull();
    expect(absent.calls.waited).toEqual([]);
  });

  it('OOM-flagged while still "running": waits for the exit record, then reads the death', async () => {
    const shell: ShellState = {
      status: 'running',
      oomKilled: true,
      exitCode: 0,
      pid: process.pid, // the one OOM shape measured where init was not yet a zombie
      finishedAt: '0001-01-01T00:00:00Z',
    };
    let seen: { condition?: string; abortSignal?: AbortSignal } | undefined;
    const { docker, calls } = stubDocker(shell, async (opts) => {
      seen = opts;
      // The runtime catches up during the wait, as measured (165-266ms).
      await sleep(20);
      shell.status = 'exited';
      shell.exitCode = 137;
      shell.pid = 0;
      shell.finishedAt = '2026-09-09T04:04:16.673943905Z';
      return { StatusCode: 137 };
    });
    expect(await executor(docker).exitOf('sbx')).toEqual({
      exitCode: 137,
      oomKilled: true,
      runtimeDied: false,
      finishedAt: '2026-09-09T04:04:16.673Z',
    });
    // Waited on the container by id, bounded by a live abort signal, then
    // read again by name.
    expect(calls.waited).toEqual(['c0ffee']);
    expect(seen?.condition).toBe('not-running');
    expect(seen?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(seen?.abortSignal?.aborted).toBe(false);
    expect(calls.inspected).toEqual([
      containerName('sbx'),
      containerName('sbx'),
    ]);
  });

  it('still running once the bounded wait gives up: alive after all, null', async () => {
    const { docker, calls } = stubDocker(
      {
        status: 'running',
        oomKilled: true,
        exitCode: 0,
        pid: process.pid,
        finishedAt: '0001-01-01T00:00:00Z',
      },
      ABORTED,
    );
    expect(await executor(docker).exitOf('sbx')).toBeNull();
    expect(calls.waited).toEqual(['c0ffee']);
    expect(calls.inspected).toHaveLength(2);
  });

  it.skipIf(!linux)(
    'init a zombie on the host while Docker still says running: the pids-cap shape, read as the sentry dying',
    async () => {
      const zombie = await spawnZombie();
      cleanups.push(() => zombie.parent.kill('SIGKILL'));
      const shell: ShellState = {
        status: 'running',
        oomKilled: false,
        exitCode: 0,
        pid: zombie.pid,
        finishedAt: '0001-01-01T00:00:00Z',
      };
      const { docker, calls } = stubDocker(shell, async () => {
        shell.status = 'exited';
        shell.exitCode = 2;
        shell.pid = 0;
        shell.finishedAt = '2026-09-09T04:04:24.709696455Z';
        return { StatusCode: 2 };
      });
      expect(await executor(docker).exitOf('sbx')).toEqual({
        exitCode: 2,
        oomKilled: false,
        runtimeDied: true,
        finishedAt: '2026-09-09T04:04:24.709Z',
      });
      expect(calls.waited).toEqual(['c0ffee']);
    },
  );

  it.skipIf(!linux)(
    'init already reaped (no /proc entry) while Docker still says running: the same wait',
    async () => {
      const zombie = await spawnZombie();
      // Killing the helper reparents the zombie to init, which reaps it: the
      // pid is gone, exactly what Docker's State.Pid points at once the shim
      // has collected the sentry but before the status flips.
      zombie.parent.kill('SIGKILL');
      for (let i = 0; i < 100; i++) {
        try {
          await readFile(`/proc/${zombie.pid}/stat`, 'utf8');
        } catch {
          break;
        }
        await sleep(20);
      }
      const { docker, calls } = stubDocker(
        {
          status: 'running',
          oomKilled: false,
          exitCode: 0,
          pid: zombie.pid,
          finishedAt: '0001-01-01T00:00:00Z',
        },
        ABORTED,
      );
      expect(await executor(docker).exitOf('sbx')).toBeNull();
      expect(calls.waited).toEqual(['c0ffee']);
    },
  );

  it('parses one counter out of a cgroup-v2 events file', () => {
    expect(cgroupCounter(QUIET_MEMORY, 'oom_kill')).toBe(0);
    expect(
      cgroupCounter('low 0\nhigh 3\nmax 12\noom 1\noom_kill 1\n', 'oom_kill'),
    ).toBe(1);
    // `max` must not match `oom_group_kill`'s or another key's tail.
    expect(cgroupCounter('max 7\n', 'max')).toBe(7);
    expect(cgroupCounter('', 'max')).toBe(0);
  });

  it("the shim's OOM relay dead: no OOMKilled, init still S — the cgroup's own oom_kill counter is the verdict", async () => {
    // A production shape (2026-09-09): the host's inotify instances ran
    // out, the shim never set State.OOMKilled, and at the default
    // memory.oom.group=0 the sentry lingered in S for ~650ms. Nothing
    // Docker reports says death; the kernel's counter does.
    const cgroup = await stagedCgroup(
      'low 0\nhigh 0\nmax 0\noom 1\noom_kill 1\noom_group_kill 0\n',
      QUIET_PIDS,
    );
    cleanups.push(() => void cgroup.cleanup());
    const shell: ShellState = {
      status: 'running',
      oomKilled: false,
      exitCode: 0,
      pid: process.pid,
      finishedAt: '0001-01-01T00:00:00Z',
    };
    const { docker, calls } = stubDocker(shell, async () => {
      shell.status = 'exited';
      shell.exitCode = 137;
      shell.pid = 0;
      shell.finishedAt = '2026-09-09T12:31:46.000000000Z';
      return { StatusCode: 137 };
    });
    expect(await executor(docker, cgroup.root).exitOf('sbx')).toEqual({
      exitCode: 137,
      oomKilled: true,
      runtimeDied: false,
      finishedAt: '2026-09-09T12:31:46.000Z',
    });
    expect(calls.waited).toEqual(['c0ffee']);
  });

  it('the pids cap refused a fork: pids.events max>0 on a "running" shell is the sentry dying', async () => {
    const cgroup = await stagedCgroup(QUIET_MEMORY, 'max 3\n');
    cleanups.push(() => void cgroup.cleanup());
    const shell: ShellState = {
      status: 'running',
      oomKilled: false,
      exitCode: 0,
      pid: process.pid,
      finishedAt: '0001-01-01T00:00:00Z',
    };
    const { docker, calls } = stubDocker(shell, async () => {
      shell.status = 'exited';
      shell.exitCode = 2;
      shell.pid = 0;
      shell.finishedAt = '2026-09-09T04:04:24.709696455Z';
      return { StatusCode: 2 };
    });
    expect(await executor(docker, cgroup.root).exitOf('sbx')).toEqual({
      exitCode: 2,
      oomKilled: false,
      runtimeDied: true,
      finishedAt: '2026-09-09T04:04:24.709Z',
    });
    expect(calls.waited).toEqual(['c0ffee']);
  });

  it('quiet counters and a live init: alive, no wait', async () => {
    const cgroup = await stagedCgroup(QUIET_MEMORY, QUIET_PIDS);
    cleanups.push(() => void cgroup.cleanup());
    const { docker, calls } = stubDocker(
      {
        status: 'running',
        oomKilled: false,
        exitCode: 0,
        pid: process.pid,
        finishedAt: '0001-01-01T00:00:00Z',
      },
      NEVER,
    );
    expect(await executor(docker, cgroup.root).exitOf('sbx')).toBeNull();
    expect(calls.waited).toEqual([]);
  });

  it('off Linux there is no /proc to read: a running shell with no OOM flag is alive, whatever its pid', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    cleanups.push(() => {
      if (platform) Object.defineProperty(process, 'platform', platform);
    });
    const { docker, calls } = stubDocker(
      {
        status: 'running',
        oomKilled: false,
        exitCode: 0,
        pid: 2 ** 22 - 1,
        finishedAt: '0001-01-01T00:00:00Z',
      },
      NEVER,
    );
    expect(await executor(docker).exitOf('sbx')).toBeNull();
    expect(calls.waited).toEqual([]);
  });
});
