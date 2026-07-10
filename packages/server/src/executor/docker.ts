import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  chown,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  statfs,
} from 'node:fs/promises';
import path from 'node:path';
import { type Duplex, Transform, type Writable } from 'node:stream';
import {
  EXEC_OUTPUT_LIMIT_BYTES,
  FILE_SIZE_LIMIT_BYTES,
  resolveSandboxPath,
} from '@dormice/shared';
import Docker from 'dockerode';
import { execa } from 'execa';
import {
  ALREADY_EXISTS_EXIT,
  entryFromFindRecord,
  entryFromStatLine,
  execStreamWrapper,
  FILE_OP_TIMEOUT_SECONDS,
  LIST_DIR_SCRIPT,
  LIST_OUTPUT_LIMIT_BYTES,
  MAKE_DIR_SCRIPT,
  MOVE_SCRIPT,
  NO_SUCH_FILE_EXIT,
  NOT_A_DIR_EXIT,
  NOT_A_FILE_EXIT,
  PTY_WRAPPER,
  parseInotifyLine,
  READ_FILE_SCRIPT,
  READ_FILE_STREAM_SCRIPT,
  REMOVE_SCRIPT,
  SIGNAL_SCRIPT,
  STAT_SCRIPT,
  STREAM_FILE_OP_TIMEOUT_SECONDS,
  TOO_LARGE_EXIT,
  WATCH_SCRIPT,
  WRITE_FILE_SCRIPT,
} from './docker-scripts';
import { CallbackSink, CappedBuffer } from './docker-streams';
import {
  type ContainerState,
  DiskFullError,
  type DiskUsage,
  type ExecOptions,
  type ExecResult,
  type ExecStreamHandle,
  type ExecStreamOptions,
  type Executor,
  FileNotFoundError,
  FileTooLargeError,
  type FileToWrite,
  NotADirectoryError,
  NotAFileError,
  type PtySize,
  type SandboxEntry,
  type SandboxMetrics,
  type ShellOptions,
  type WatchDirHandle,
  type WatchDirOptions,
} from './executor';

/**
 * Label that marks a container as ours, holding the sandbox id. Listing by
 * this label is how reconciliation claims Dormice's containers and ignores
 * whatever else runs on the machine.
 */
export const SANDBOX_LABEL = 'dormice.sandbox';

export interface DockerExecutorOptions {
  /** Image every sandbox boots from, e.g. dormice-base:20260708. */
  baseImage: string;
  /** Sparse disk images and their mount points live under this directory. */
  dataDir: string;
  /** Size cap of each sandbox disk. The limit is physical: the image file simply ends. */
  diskSizeGb: number;
  cpus: number;
  memoryGb: number;
  pidsLimit: number;
  /** How long one memory.reclaim write may take before its subprocess is killed. */
  reclaimTimeoutSeconds: number;
  log?: (msg: string) => void;
}

export function containerName(sandboxId: string): string {
  return `sbx-${sandboxId}`;
}

/**
 * Docker reports seven statuses; the executor's contract knows three. With
 * RestartPolicy "no" a container never restarts on its own, so everything
 * that is not running or paused is some flavor of "processes are dead,
 * disk remains" — exactly what the contract calls stopped.
 */
export function containerStateFromDocker(status: string): ContainerState {
  if (status === 'running') return 'running';
  if (status === 'paused') return 'paused';
  return 'stopped';
}

/** The daemon runs as root; refuse to rm anything that escaped dataDir. */
export function assertInside(base: string, target: string): void {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to touch ${target}: outside ${base}`);
  }
}

interface DockerApiError {
  statusCode: number;
}

function isDockerApiError(err: unknown): err is DockerApiError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as DockerApiError).statusCode === 'number'
  );
}

/**
 * The real executor: Docker + gVisor for isolation, one loopback-mounted
 * sparse image per sandbox for disk quota. Linux-only and needs root (mount,
 * cgroup writes); everything else in the daemon keeps running against
 * FakeExecutor, which this class must behave identically to — both pass the
 * same contract test suite, including error messages.
 */
export class DockerExecutor implements Executor {
  private readonly docker: Docker;
  private readonly opts: DockerExecutorOptions;
  private readonly log: (msg: string) => void;

  constructor(opts: DockerExecutorOptions, docker?: Docker) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    // The local socket only. Red line: this socket is the daemon's alone and
    // must never be mounted into any container.
    this.docker = docker ?? new Docker({ socketPath: '/var/run/docker.sock' });
  }

  async create(sandboxId: string, opts?: ShellOptions): Promise<void> {
    if ((await this.inspect(sandboxId)) !== null) {
      throw new Error(`container ${sandboxId} already exists`);
    }
    await this.provisionDisk(sandboxId);
    await this.launchContainer(sandboxId, opts?.image);
  }

  async freeze(sandboxId: string): Promise<void> {
    const containerId = await this.expectState(sandboxId, 'running');
    await this.docker.getContainer(containerId).pause();
    await this.reclaimMemory(containerId);
  }

  async unfreeze(sandboxId: string): Promise<void> {
    const containerId = await this.expectState(sandboxId, 'paused');
    // Milliseconds; memory swaps back in lazily, on demand.
    await this.docker.getContainer(containerId).unpause();
  }

  async stop(sandboxId: string): Promise<void> {
    const containerId = await this.expectState(sandboxId, 'paused');
    const container = this.docker.getContainer(containerId);
    // Unpause first: a signal cannot be delivered into a paused gVisor
    // sandbox — its guest kernel is stopped along with everything else
    // (measured 2026-07-09; dockerd itself burns a hard-coded 10s wait on
    // exactly this before escalating).
    await container.unpause();
    // SIGKILL, no grace period: the sandbox has nothing to shut down
    // cleanly (crash-only — code must survive the container vanishing
    // anyway), and the disk's consistency is the ext4 journal's job.
    await container.kill();
    // kill only delivers the signal; Docker marks the container exited a
    // beat later. Wait for that, so the caller observes 'stopped' the
    // moment stop() resolves — the same synchronous promise the fake makes.
    await container.wait({ condition: 'not-running' });
  }

  async start(sandboxId: string, opts?: ShellOptions): Promise<void> {
    const found = await this.inspect(sandboxId);
    if (found === null) {
      // The container object is gone — a routine `docker container prune`
      // eats exited containers — but the disk survives, and the disk is the
      // sandbox's data. Rebuild the replaceable shell around it.
      if (!(await this.diskExists(sandboxId))) {
        throw new Error(`disk ${sandboxId} is absent, cannot start`);
      }
      await this.ensureMounted(sandboxId);
      await this.launchContainer(sandboxId, opts?.image);
      return;
    }
    const actual = containerStateFromDocker(found.status);
    if (actual !== 'stopped') {
      throw new Error(`container ${sandboxId} is ${actual}, expected stopped`);
    }
    // Loop mounts live in kernel memory and are gone after a host reboot,
    // while the image file and the stopped container survive on disk.
    await this.ensureMounted(sandboxId);
    await this.docker.getContainer(found.id).start();
  }

  async destroy(sandboxId: string): Promise<void> {
    const found = await this.inspect(sandboxId);
    if (found === null) {
      // Half-gone still needs the other half: a pruned container leaves its
      // disk behind, and destroy promises "container and disk gone". Both
      // already absent means the ledger and reality disagree — a bug worth
      // hearing, same contract as the fake. Vanished-with-disk sandboxes
      // are otherwise the reconciler's case, not a silent success here.
      if (!(await this.diskExists(sandboxId))) {
        throw new Error(`container ${sandboxId} is absent, cannot destroy`);
      }
      await this.teardownDisk(sandboxId);
      return;
    }
    await this.takeContainerDown(found);
    await this.teardownDisk(sandboxId);
  }

  async removeContainer(sandboxId: string): Promise<void> {
    const found = await this.inspect(sandboxId);
    if (found === null) {
      // Already gone is the goal state — but only alongside a surviving
      // disk. Both absent means the ledger points at nothing, worth hearing
      // (destroy's contract, same message shape).
      if (!(await this.diskExists(sandboxId))) {
        throw new Error(`container ${sandboxId} is absent, cannot remove`);
      }
      return;
    }
    await this.takeContainerDown(found);
  }

  /**
   * Walks a container down from any state and removes it, ourselves instead
   * of leaning on remove's force-kill: dockerd cannot deliver a signal into
   * a paused gVisor sandbox and burns a hard-coded 10s wait before
   * escalating (measured 2026-07-09, sometimes erroring "PID is zombie").
   * Unpause so the kill lands, then wait for the actual exit before removing.
   */
  private async takeContainerDown(found: {
    id: string;
    status: string;
  }): Promise<void> {
    const container = this.docker.getContainer(found.id);
    if (found.status === 'paused') {
      await container.unpause();
    }
    if (found.status === 'paused' || found.status === 'running') {
      try {
        await container.kill();
      } catch (err) {
        // Died between inspect and kill — the goal state, not a failure.
        if (!isDockerApiError(err) || err.statusCode !== 409) throw err;
      }
      await container.wait({ condition: 'not-running' });
    }
    await container.remove({ force: true });
  }

  async listContainers(): Promise<Map<string, ContainerState>> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [SANDBOX_LABEL] },
    });
    const observed = new Map<string, ContainerState>();
    for (const c of containers) {
      const sandboxId = c.Labels[SANDBOX_LABEL];
      if (sandboxId) {
        observed.set(sandboxId, containerStateFromDocker(c.State));
      }
    }
    return observed;
  }

  async listDisks(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(path.join(this.opts.dataDir, 'disks'));
    } catch (err) {
      // No disks directory yet — no sandbox has ever been created here.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return entries
      .filter((name) => name.endsWith('.img'))
      .map((name) => name.slice(0, -'.img'.length));
  }

  async removeDisk(sandboxId: string): Promise<void> {
    // Idempotent by contract: teardown already treats "nothing mounted"
    // and "no such file" as the goal state.
    await this.teardownDisk(sandboxId);
  }

  async exportDisk(sandboxId: string, destPath: string): Promise<void> {
    const found = await this.inspect(sandboxId);
    if (found !== null) {
      const actual = containerStateFromDocker(found.status);
      if (actual !== 'stopped') {
        throw new Error(
          `container ${sandboxId} is ${actual}, expected stopped or absent`,
        );
      }
    }
    if (!(await this.diskExists(sandboxId))) {
      throw new Error(`disk ${sandboxId} is absent, cannot export`);
    }
    // A host reboot drops loop mounts while the image file survives; the
    // tree has to be mounted to be read.
    await this.ensureMounted(sandboxId);
    // The mounted tree, not the raw image: the container is dead, so the
    // tree is quiescent, and importDisk provisioning a fresh disk is what
    // lets the restored sandbox follow the current size configuration.
    // tar does not follow symlinks, so a link planted by the sandbox is
    // archived as a link, never chased by the root-running daemon.
    await execa('tar', [
      '-I',
      'zstd -T0',
      '-cf',
      destPath,
      '-C',
      this.mountDir(sandboxId),
      '.',
    ]);
  }

  async importDisk(
    sandboxId: string,
    srcPath: string,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    if (await this.diskExists(sandboxId)) {
      throw new Error(`disk ${sandboxId} already exists, cannot import`);
    }
    await this.provisionDisk(sandboxId);
    try {
      const { size } = await stat(srcPath);
      let consumed = 0;
      // The archive is fed through a byte-counting stream into tar's stdin,
      // so progress is what actually reached the extractor — not a guess.
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          consumed += chunk.length;
          onProgress?.(size > 0 ? consumed / size : 1);
          callback(null, chunk);
        },
      });
      createReadStream(srcPath).pipe(meter);
      // -p as root restores the recorded owners — uid-1000 files stay
      // uid 1000 (measured in the predecessor system).
      await execa(
        'tar',
        ['-I', 'zstd', '-xpf', '-', '-C', this.mountDir(sandboxId)],
        { input: meter },
      );
      onProgress?.(1);
    } catch (err) {
      // Leave no half-disk behind the verb's own failure.
      await this.teardownDisk(sandboxId);
      throw err;
    }
  }

  async diskUsage(): Promise<DiskUsage> {
    const disksDir = path.join(this.opts.dataDir, 'disks');
    let entries: string[];
    try {
      entries = await readdir(disksDir);
    } catch (err) {
      // No disks directory yet — no sandbox has ever been created here.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { count: 0, nominalBytes: 0, actualBytes: 0 };
      }
      throw err;
    }
    const usage: DiskUsage = { count: 0, nominalBytes: 0, actualBytes: 0 };
    for (const name of entries) {
      if (!name.endsWith('.img')) continue;
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(path.join(disksDir, name));
      } catch (err) {
        // Torn down by a concurrent release between readdir and stat —
        // a snapshot simply does not count what is no longer there.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      usage.count += 1;
      // size is what truncate promised; blocks (always 512-byte units) is
      // what the sparse image really occupies. Their gap is the overcommit.
      usage.nominalBytes += s.size;
      usage.actualBytes += s.blocks * 512;
    }
    return usage;
  }

  async resolvePortTarget(
    sandboxId: string,
    port: number,
  ): Promise<{ host: string; port: number }> {
    const containerId = await this.expectState(sandboxId, 'running');
    const info = await this.docker.getContainer(containerId).inspect();
    // The bridge address: icc:false only blocks container-to-container
    // traffic, host-to-container stays open (measured on the test machine).
    const networks = info.NetworkSettings?.Networks ?? {};
    const ip = Object.values(networks)
      .map((n) => n?.IPAddress)
      .find((addr) => !!addr);
    if (!ip) {
      throw new Error(`container ${sandboxId} has no network address`);
    }
    return { host: ip, port };
  }

  async metrics(sandboxId: string): Promise<SandboxMetrics> {
    const found = await this.inspect(sandboxId);
    const actual =
      found === null ? undefined : containerStateFromDocker(found.status);
    if (found === null || (actual !== 'running' && actual !== 'paused')) {
      throw new Error(
        `container ${sandboxId} is ${actual ?? 'absent'}, expected running or paused`,
      );
    }
    // stream:false makes the engine take two samples a beat apart so the
    // CPU delta below has a denominator; one reading costs about a second.
    const stats = await this.docker
      .getContainer(found.id)
      .stats({ stream: false });
    const cpuDelta =
      (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
      (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta =
      (stats.cpu_stats?.system_cpu_usage ?? 0) -
      (stats.precpu_stats?.system_cpu_usage ?? 0);
    const onlineCpus = stats.cpu_stats?.online_cpus || this.opts.cpus;
    // cgroup v2 calls the page cache inactive_file; v1 calls it cache.
    const memStats = (stats.memory_stats?.stats ?? {}) as Record<
      string,
      number
    >;
    const disk = await statfs(this.mountDir(sandboxId));
    return {
      cpuCount: this.opts.cpus,
      cpuUsedPct:
        systemDelta > 0 && cpuDelta > 0
          ? (cpuDelta / systemDelta) * onlineCpus * 100
          : 0,
      memUsedBytes: stats.memory_stats?.usage ?? 0,
      memTotalBytes:
        stats.memory_stats?.limit || Math.round(this.opts.memoryGb * 1024 ** 3),
      memCacheBytes: memStats.cache ?? memStats.inactive_file ?? 0,
      diskUsedBytes: (disk.blocks - disk.bfree) * disk.bsize,
      diskTotalBytes: disk.blocks * disk.bsize,
    };
  }

  async exec(sandboxId: string, opts: ExecOptions): Promise<ExecResult> {
    const containerId = await this.expectState(sandboxId, 'running');
    const container = this.docker.getContainer(containerId);
    // The deadline lives in-container, via GNU timeout: closing the
    // host-side stream cannot kill the in-container process (measured in
    // the predecessor system); only an in-container SIGKILL can. 137 = killed.
    const run = await this.runInContainer(container, sandboxId, {
      cmd: [
        'timeout',
        '--signal=KILL',
        String(opts.timeoutSeconds),
        'bash',
        '-c',
        opts.command,
      ],
      outputCap: EXEC_OUTPUT_LIMIT_BYTES,
      workingDir: opts.cwd,
      env: opts.env,
      user: opts.user,
    });
    return {
      exitCode: run.exitCode,
      stdout: run.stdout.text(),
      stderr: run.stderr.text(),
      stdoutTruncated: run.stdout.truncated,
      stderrTruncated: run.stderr.truncated,
    };
  }

  async execStream(
    sandboxId: string,
    opts: ExecStreamOptions,
  ): Promise<ExecStreamHandle> {
    const containerId = await this.expectState(sandboxId, 'running');
    const container = this.docker.getContainer(containerId);
    // The pidfile is the handle's way back to the process: /tmp is the
    // sandbox's own, so a leftover file is the sandbox's own garbage — it
    // is deliberately not removed on kill, or a TERM that the process
    // survives would strand the follow-up KILL.
    const pidfile = `/tmp/.dormice-exec-${randomUUID()}.pid`;
    if (opts.pty) {
      return this.startPtySession(
        container,
        sandboxId,
        pidfile,
        opts,
        opts.pty,
      );
    }
    if (opts.command === undefined) {
      throw new Error('execStream needs a command unless pty is set');
    }
    const started = await this.startInContainer(container, sandboxId, {
      cmd: [
        'bash',
        '-c',
        execStreamWrapper(opts.loginShell ?? false),
        'bash',
        pidfile,
        String(opts.timeoutSeconds),
        opts.command,
      ],
      stdout: new CallbackSink(opts.onStdout),
      stderr: new CallbackSink(opts.onStderr),
      stdin: opts.stdin ? 'open' : undefined,
      workingDir: opts.cwd,
      env: opts.env,
      user: opts.user,
    });
    let finished = false;
    const done = started.wait().then((exitCode) => {
      finished = true;
      return { exitCode };
    });
    done.catch(() => {
      finished = true;
    });
    const stdinStream = started.stdinStream;
    return {
      wait: () => done,
      sendStdin: async (data) => {
        if (!stdinStream) {
          throw new Error('process was started without stdin');
        }
        if (stdinStream.writableEnded) {
          throw new Error('stdin is closed');
        }
        await new Promise<void>((resolve, reject) => {
          stdinStream.write(data, (err) => (err ? reject(err) : resolve()));
        });
      },
      closeStdin: async () => {
        if (!stdinStream) {
          throw new Error('process was started without stdin');
        }
        if (stdinStream.writableEnded) {
          throw new Error('stdin is closed');
        }
        await new Promise<void>((resolve) => {
          stdinStream.end(resolve);
        });
      },
      signal: async (sig) => {
        if (finished) {
          throw new Error('process already exited');
        }
        await this.signalProcess(container, sandboxId, pidfile, sig, opts.user);
      },
      resizePty: async () => {
        throw new Error('process has no PTY');
      },
    };
  }

  /**
   * Delivers a signal to an execStream'd process group via its pidfile —
   * as the same user the process runs as: uid 1000 cannot signal a root
   * process group, and root needs no help signaling anyone.
   */
  private async signalProcess(
    container: Docker.Container,
    sandboxId: string,
    pidfile: string,
    sig: 'SIGTERM' | 'SIGKILL',
    user?: string,
  ): Promise<void> {
    const run = await this.runInContainer(container, sandboxId, {
      cmd: ['bash', '-c', SIGNAL_SCRIPT, 'bash', pidfile, sig],
      outputCap: EXEC_OUTPUT_LIMIT_BYTES,
      user,
    });
    if (run.exitCode !== 0) {
      throw new Error(
        `signaling process in ${sandboxId} failed (exit ${run.exitCode}): ${run.stderr.text().trim()}`,
      );
    }
  }

  /**
   * The PTY path: `docker exec` with Tty on — one merged raw byte stream
   * (nothing to demux; stdout and stderr are the same terminal), resize via
   * the engine's own exec resize, input over the same hijacked duplex.
   */
  private async startPtySession(
    container: Docker.Container,
    sandboxId: string,
    pidfile: string,
    opts: ExecStreamOptions,
    size: PtySize,
  ): Promise<ExecStreamHandle> {
    const exec = await container.exec({
      Cmd: ['bash', '-c', PTY_WRAPPER, 'bash', pidfile],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      WorkingDir: opts.cwd,
      Env: opts.env
        ? Object.entries(opts.env).map(([key, value]) => `${key}=${value}`)
        : undefined,
      // The PTY twin of startInContainer's identity point.
      User: opts.user ?? 'user',
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    stream.pipe(new CallbackSink(opts.onStdout));
    // The engine takes the size only after start — the terminal is born
    // 0x0 otherwise, and a shell that stats it misbehaves.
    await exec.resize({ h: size.rows, w: size.cols });
    const finished = this.awaitExitCode(exec, stream, sandboxId);
    let finishedFlag = false;
    const done = finished.then((exitCode) => {
      finishedFlag = true;
      return { exitCode };
    });
    done.catch(() => {
      finishedFlag = true;
    });
    return {
      wait: () => done,
      sendStdin: async (data) => {
        if (stream.writableEnded) {
          throw new Error('stdin is closed');
        }
        await new Promise<void>((resolve, reject) => {
          stream.write(data, (err) => (err ? reject(err) : resolve()));
        });
      },
      closeStdin: async () => {
        if (stream.writableEnded) {
          throw new Error('stdin is closed');
        }
        await new Promise<void>((resolve) => {
          stream.end(resolve);
        });
      },
      signal: async (sig) => {
        if (finishedFlag) {
          throw new Error('process already exited');
        }
        await this.signalProcess(container, sandboxId, pidfile, sig, opts.user);
      },
      resizePty: async (next) => {
        await exec.resize({ h: next.rows, w: next.cols });
      },
    };
  }

  /**
   * Stream over, exit code out: the engine records the code a beat after
   * the stream ends — the same measured lag as kill vs exited in stop().
   * Never rejects into the void: callers hold the promise through wait().
   */
  private async awaitExitCode(
    exec: Docker.Exec,
    stream: NodeJS.ReadableStream,
    sandboxId: string,
  ): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('close', resolve);
      stream.on('error', reject);
    });
    let info = await exec.inspect();
    for (let i = 0; info.Running || info.ExitCode === null; i++) {
      if (i >= 20) {
        throw new Error(
          `exec on ${sandboxId} ended but no exit code was recorded`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      info = await exec.inspect();
    }
    return info.ExitCode;
  }

  async writeFiles(
    sandboxId: string,
    files: FileToWrite[],
    user?: string,
  ): Promise<void> {
    const containerId = await this.expectState(sandboxId, 'running');
    const container = this.docker.getContainer(containerId);
    // In array order, failing fast — the batch saves round-trips, it is not
    // a transaction; earlier files stay written, as the protocol documents.
    for (const file of files) {
      const path = resolveSandboxPath(file.path);
      const run = await this.runInContainer(container, sandboxId, {
        cmd: [
          'timeout',
          '--signal=KILL',
          String(FILE_OP_TIMEOUT_SECONDS),
          'bash',
          '-c',
          WRITE_FILE_SCRIPT,
          'bash',
          path,
        ],
        outputCap: EXEC_OUTPUT_LIMIT_BYTES,
        stdin: file.content,
        user,
      });
      if (run.exitCode === NOT_A_FILE_EXIT) {
        throw new NotAFileError(`not a regular file: ${path}`);
      }
      if (run.exitCode !== 0) {
        throw new Error(
          `writing ${path} in ${sandboxId} failed (exit ${run.exitCode}): ${run.stderr.text().trim()}`,
        );
      }
    }
  }

  async readFile(
    sandboxId: string,
    path: string,
    user?: string,
  ): Promise<Buffer> {
    const resolved = resolveSandboxPath(path);
    const containerId = await this.expectState(sandboxId, 'running');
    const container = this.docker.getContainer(containerId);
    const run = await this.runInContainer(container, sandboxId, {
      cmd: [
        'timeout',
        '--signal=KILL',
        String(FILE_OP_TIMEOUT_SECONDS),
        'bash',
        '-c',
        READ_FILE_SCRIPT,
        'bash',
        resolved,
        String(FILE_SIZE_LIMIT_BYTES),
      ],
      outputCap: FILE_SIZE_LIMIT_BYTES,
      user,
    });
    if (run.exitCode === NO_SUCH_FILE_EXIT) {
      throw new FileNotFoundError(`no such file: ${resolved}`);
    }
    if (run.exitCode === NOT_A_FILE_EXIT) {
      throw new NotAFileError(`not a regular file: ${resolved}`);
    }
    if (run.exitCode === TOO_LARGE_EXIT) {
      const size = Number(run.stderr.text().trim());
      throw new FileTooLargeError(
        `file too large: ${resolved} is ${size} bytes, limit ${FILE_SIZE_LIMIT_BYTES}`,
      );
    }
    if (run.exitCode !== 0) {
      throw new Error(
        `reading ${resolved} in ${sandboxId} failed (exit ${run.exitCode}): ${run.stderr.text().trim()}`,
      );
    }
    if (run.stdout.truncated) {
      // The size gate passed but the file grew past the cap before cat
      // finished — rare, but delivering a silently cut file is never right.
      throw new FileTooLargeError(
        `file too large: ${resolved} exceeds limit ${FILE_SIZE_LIMIT_BYTES}`,
      );
    }
    return run.stdout.bytes();
  }

  async readFileStream(
    sandboxId: string,
    path: string,
    onChunk: (chunk: Buffer) => void | Promise<void>,
    user?: string,
  ): Promise<void> {
    const resolved = resolveSandboxPath(path);
    const containerId = await this.expectState(sandboxId, 'running');
    const container = this.docker.getContainer(containerId);
    const stderr = new CappedBuffer(EXEC_OUTPUT_LIMIT_BYTES);
    const started = await this.startInContainer(container, sandboxId, {
      cmd: [
        'timeout',
        '--signal=KILL',
        String(STREAM_FILE_OP_TIMEOUT_SECONDS),
        'bash',
        '-c',
        READ_FILE_STREAM_SCRIPT,
        'bash',
        resolved,
      ],
      stdout: new CallbackSink(onChunk),
      stderr,
      user,
    });
    const exitCode = await started.wait();
    if (exitCode === NO_SUCH_FILE_EXIT) {
      throw new FileNotFoundError(`no such file: ${resolved}`);
    }
    if (exitCode === NOT_A_FILE_EXIT) {
      throw new NotAFileError(`not a regular file: ${resolved}`);
    }
    if (exitCode !== 0) {
      throw new Error(
        `reading ${resolved} in ${sandboxId} failed (exit ${exitCode}): ${stderr.text().trim()}`,
      );
    }
  }

  async writeFileStream(
    sandboxId: string,
    path: string,
    content: NodeJS.ReadableStream,
    user?: string,
  ): Promise<void> {
    const resolved = resolveSandboxPath(path);
    const containerId = await this.expectState(sandboxId, 'running');
    const container = this.docker.getContainer(containerId);
    const run = await this.runInContainer(container, sandboxId, {
      cmd: [
        'timeout',
        '--signal=KILL',
        String(STREAM_FILE_OP_TIMEOUT_SECONDS),
        'bash',
        '-c',
        WRITE_FILE_SCRIPT,
        'bash',
        resolved,
      ],
      outputCap: EXEC_OUTPUT_LIMIT_BYTES,
      stdin: content,
      user,
    });
    if (run.exitCode === NOT_A_FILE_EXIT) {
      throw new NotAFileError(`not a regular file: ${resolved}`);
    }
    if (run.exitCode !== 0) {
      const message = run.stderr.text().trim();
      if (/no space left/i.test(message)) {
        throw new DiskFullError(`no space left on device: ${resolved}`);
      }
      throw new Error(
        `writing ${resolved} in ${sandboxId} failed (exit ${run.exitCode}): ${message}`,
      );
    }
  }

  async listDir(
    sandboxId: string,
    path: string,
    depth: number,
    user?: string,
  ): Promise<SandboxEntry[]> {
    const resolved = resolveSandboxPath(path);
    const containerId = await this.expectState(sandboxId, 'running');
    const container = this.docker.getContainer(containerId);
    const run = await this.runInContainer(container, sandboxId, {
      cmd: [
        'timeout',
        '--signal=KILL',
        String(FILE_OP_TIMEOUT_SECONDS),
        'bash',
        '-c',
        LIST_DIR_SCRIPT,
        'bash',
        resolved,
        String(depth),
      ],
      outputCap: LIST_OUTPUT_LIMIT_BYTES,
      user,
    });
    if (run.exitCode === NO_SUCH_FILE_EXIT) {
      throw new FileNotFoundError(`no such file: ${resolved}`);
    }
    if (run.exitCode === NOT_A_DIR_EXIT) {
      throw new NotADirectoryError(`not a directory: ${resolved}`);
    }
    if (run.exitCode !== 0) {
      throw new Error(
        `listing ${resolved} in ${sandboxId} failed (exit ${run.exitCode}): ${run.stderr.text().trim()}`,
      );
    }
    if (run.stdout.truncated) {
      // Losing entries silently would make the listing a lie.
      throw new Error(
        `listing ${resolved} in ${sandboxId} exceeded ${LIST_OUTPUT_LIMIT_BYTES} bytes — use a smaller depth`,
      );
    }
    return run.stdout
      .bytes()
      .toString('utf8')
      .split('\0')
      .filter((record) => record.length > 0)
      .map(entryFromFindRecord)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async statEntry(
    sandboxId: string,
    path: string,
    user?: string,
  ): Promise<SandboxEntry> {
    const resolved = resolveSandboxPath(path);
    const containerId = await this.expectState(sandboxId, 'running');
    const container = this.docker.getContainer(containerId);
    const run = await this.runInContainer(container, sandboxId, {
      cmd: [
        'timeout',
        '--signal=KILL',
        String(FILE_OP_TIMEOUT_SECONDS),
        'bash',
        '-c',
        STAT_SCRIPT,
        'bash',
        resolved,
      ],
      outputCap: EXEC_OUTPUT_LIMIT_BYTES,
      user,
    });
    if (run.exitCode === NO_SUCH_FILE_EXIT) {
      throw new FileNotFoundError(`no such file: ${resolved}`);
    }
    if (run.exitCode !== 0) {
      throw new Error(
        `stat ${resolved} in ${sandboxId} failed (exit ${run.exitCode}): ${run.stderr.text().trim()}`,
      );
    }
    return entryFromStatLine(resolved, run.stdout.text());
  }

  async makeDir(
    sandboxId: string,
    path: string,
    user?: string,
  ): Promise<boolean> {
    const resolved = resolveSandboxPath(path);
    const containerId = await this.expectState(sandboxId, 'running');
    const container = this.docker.getContainer(containerId);
    const run = await this.runInContainer(container, sandboxId, {
      cmd: [
        'timeout',
        '--signal=KILL',
        String(FILE_OP_TIMEOUT_SECONDS),
        'bash',
        '-c',
        MAKE_DIR_SCRIPT,
        'bash',
        resolved,
      ],
      outputCap: EXEC_OUTPUT_LIMIT_BYTES,
      user,
    });
    if (run.exitCode === ALREADY_EXISTS_EXIT) {
      return false;
    }
    if (run.exitCode !== 0) {
      throw new Error(
        `mkdir ${resolved} in ${sandboxId} failed (exit ${run.exitCode}): ${run.stderr.text().trim()}`,
      );
    }
    return true;
  }

  async move(
    sandboxId: string,
    from: string,
    to: string,
    user?: string,
  ): Promise<SandboxEntry> {
    const source = resolveSandboxPath(from);
    const destination = resolveSandboxPath(to);
    const containerId = await this.expectState(sandboxId, 'running');
    const container = this.docker.getContainer(containerId);
    const run = await this.runInContainer(container, sandboxId, {
      cmd: [
        'timeout',
        '--signal=KILL',
        String(FILE_OP_TIMEOUT_SECONDS),
        'bash',
        '-c',
        MOVE_SCRIPT,
        'bash',
        source,
        destination,
      ],
      outputCap: EXEC_OUTPUT_LIMIT_BYTES,
      user,
    });
    if (run.exitCode === NO_SUCH_FILE_EXIT) {
      throw new FileNotFoundError(`no such file: ${source}`);
    }
    if (run.exitCode !== 0) {
      throw new Error(
        `moving ${source} to ${destination} in ${sandboxId} failed (exit ${run.exitCode}): ${run.stderr.text().trim()}`,
      );
    }
    return this.statEntry(sandboxId, destination, user);
  }

  async remove(sandboxId: string, path: string, user?: string): Promise<void> {
    const resolved = resolveSandboxPath(path);
    const containerId = await this.expectState(sandboxId, 'running');
    const container = this.docker.getContainer(containerId);
    const run = await this.runInContainer(container, sandboxId, {
      cmd: [
        'timeout',
        '--signal=KILL',
        String(FILE_OP_TIMEOUT_SECONDS),
        'bash',
        '-c',
        REMOVE_SCRIPT,
        'bash',
        resolved,
      ],
      outputCap: EXEC_OUTPUT_LIMIT_BYTES,
      user,
    });
    if (run.exitCode === NO_SUCH_FILE_EXIT) {
      throw new FileNotFoundError(`no such file: ${resolved}`);
    }
    if (run.exitCode !== 0) {
      throw new Error(
        `removing ${resolved} in ${sandboxId} failed (exit ${run.exitCode}): ${run.stderr.text().trim()}`,
      );
    }
  }

  async watchDir(
    sandboxId: string,
    opts: WatchDirOptions,
  ): Promise<WatchDirHandle> {
    const resolved = resolveSandboxPath(opts.path);
    const containerId = await this.expectState(sandboxId, 'running');
    const container = this.docker.getContainer(containerId);
    const pidfile = `/tmp/.dormice-exec-${randomUUID()}.pid`;

    // Once true, arriving lines drain and drop — after stop() nothing is
    // delivered, even the pipe's stragglers.
    let stopped = false;
    let pending = '';
    const onStdout = async (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      while (true) {
        const eol = pending.indexOf('\n');
        if (eol === -1) return;
        const line = pending.slice(0, eol);
        pending = pending.slice(eol + 1);
        for (const event of parseInotifyLine(line, resolved)) {
          // Awaited: backpressure travels through to inotifywait's pipe.
          if (!stopped) await opts.onEvent(event);
        }
      }
    };
    let stderrText = '';
    let markReady = () => {};
    const ready = new Promise<'ready'>((resolve) => {
      markReady = () => resolve('ready');
    });
    const onStderr = (chunk: Buffer) => {
      stderrText += chunk.toString('utf8');
      if (stderrText.includes('Watches established.')) markReady();
    };

    const started = await this.startInContainer(container, sandboxId, {
      cmd: [
        'bash',
        '-c',
        WATCH_SCRIPT,
        'bash',
        pidfile,
        opts.recursive ? '-r' : '',
        resolved,
      ],
      stdout: new CallbackSink(onStdout),
      stderr: new CallbackSink(onStderr),
    });
    const exitInfo = started.wait().then(
      (exitCode) => ({ exitCode, error: undefined as Error | undefined }),
      (error) => ({
        exitCode: -1,
        error: error instanceof Error ? error : new Error(String(error)),
      }),
    );

    const outcome = await Promise.race([ready, exitInfo]);
    if (outcome !== 'ready') {
      // The script spoke through its exit code before the watch stood up.
      if (outcome.exitCode === NO_SUCH_FILE_EXIT) {
        throw new FileNotFoundError(`no such file: ${resolved}`);
      }
      if (outcome.exitCode === NOT_A_DIR_EXIT) {
        throw new NotADirectoryError(`not a directory: ${resolved}`);
      }
      if (outcome.exitCode === 127) {
        throw new Error(
          `inotifywait is not in this sandbox's image — rebuild it from images/Dockerfile (it installs inotify-tools) to enable watch`,
        );
      }
      throw new Error(
        `starting watcher on ${resolved} in ${sandboxId} failed (exit ${outcome.exitCode}): ${stderrText.trim()}`,
      );
    }

    void exitInfo.then(({ exitCode, error }) => {
      if (stopped) return;
      stopped = true;
      opts.onEnd(
        error ?? new Error(`watcher on ${resolved} exited with ${exitCode}`),
      );
    });

    return {
      stop: async () => {
        if (stopped) return;
        stopped = true;
        try {
          await this.signalProcess(container, sandboxId, pidfile, 'SIGKILL');
        } catch {
          // The container is paused or gone: the signal cannot land, so
          // waiting for the exit would hang. The stopped flag already
          // silences the watcher; the process itself is reaped by the
          // container's own death or the 24h backstop.
          return;
        }
        await exitInfo;
      },
    };
  }

  /** The buffered face of the exec pipeline: capped sinks, awaited to the end. */
  private async runInContainer(
    container: Docker.Container,
    sandboxId: string,
    spec: {
      cmd: string[];
      outputCap: number;
      stdin?: Buffer | NodeJS.ReadableStream;
      workingDir?: string;
      env?: Record<string, string>;
      user?: string;
    },
  ): Promise<{ exitCode: number; stdout: CappedBuffer; stderr: CappedBuffer }> {
    const stdout = new CappedBuffer(spec.outputCap);
    const stderr = new CappedBuffer(spec.outputCap);
    const started = await this.startInContainer(container, sandboxId, {
      cmd: spec.cmd,
      stdout,
      stderr,
      stdin: spec.stdin,
      workingDir: spec.workingDir,
      env: spec.env,
      user: spec.user,
    });
    return { exitCode: await started.wait(), stdout, stderr };
  }

  /**
   * The one exec pipeline: start, demux into the caller's sinks, optionally
   * feed stdin (ending the stream is what delivers EOF to the in-container
   * reader), then — inside the returned wait — wait for the stream and poll
   * for the exit code: the engine records it a beat after the stream ends,
   * the same measured lag as kill vs exited in stop(). Tty stays off: the
   * multiplexed stream is what demuxStream can split back into distinct
   * stdout and stderr. Resolving means the command has started; everything
   * after start is the wait's business.
   *
   * stdin comes in three shapes: bytes (written and ended — EOF now), a
   * source stream (piped, its end is the EOF), or 'open' — the hijacked
   * duplex is handed back as stdinStream for the caller to write and
   * half-close at will (measured with writeFiles: output keeps flowing
   * after the write side ends).
   */
  private async startInContainer(
    container: Docker.Container,
    sandboxId: string,
    spec: {
      cmd: string[];
      stdout: Writable;
      stderr: Writable;
      stdin?: Buffer | NodeJS.ReadableStream | 'open';
      workingDir?: string;
      env?: Record<string, string>;
      user?: string;
    },
  ): Promise<{ wait: () => Promise<number>; stdinStream?: Duplex }> {
    const exec = await container.exec({
      Cmd: spec.cmd,
      AttachStdin: spec.stdin !== undefined,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: spec.workingDir,
      Env: spec.env
        ? Object.entries(spec.env).map(([key, value]) => `${key}=${value}`)
        : undefined,
      // One of the two physical points where identity is decided (the PTY
      // exec is the other). Root here is root inside gVisor's guest kernel,
      // nothing more.
      User: spec.user ?? 'user',
    });
    const stream = await exec.start(
      spec.stdin !== undefined ? { hijack: true, stdin: true } : {},
    );
    this.docker.modem.demuxStream(stream, spec.stdout, spec.stderr);
    if (spec.stdin !== undefined && spec.stdin !== 'open') {
      if (Buffer.isBuffer(spec.stdin)) {
        stream.end(spec.stdin);
      } else {
        // pipe() forwards the source's end as the exec's stdin EOF. A source
        // error would otherwise leave the in-container reader waiting for
        // the timeout wrapper to kill it — destroying the stream surfaces
        // the failure now instead.
        spec.stdin.on('error', (err) => stream.destroy(err));
        spec.stdin.pipe(stream);
      }
    }
    const finished = this.awaitExitCode(exec, stream, sandboxId);
    // A failure before anyone calls wait must not crash the daemon as an
    // unhandled rejection; wait() still observes it through the same promise.
    finished.catch(() => {});
    return {
      wait: () => finished,
      stdinStream: spec.stdin === 'open' ? stream : undefined,
    };
  }

  private imagePath(sandboxId: string): string {
    return path.join(this.opts.dataDir, 'disks', `${sandboxId}.img`);
  }

  private mountDir(sandboxId: string): string {
    return path.join(this.opts.dataDir, 'mnt', sandboxId);
  }

  private async diskExists(sandboxId: string): Promise<boolean> {
    try {
      await access(this.imagePath(sandboxId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates and starts the sandbox's container around its already-mounted
   * disk — the shell half of a sandbox, shared by create() (first birth)
   * and start() (rebuild after the container object was lost). The single
   * point where an image becomes a container.
   */
  private async launchContainer(
    sandboxId: string,
    image?: string,
  ): Promise<void> {
    let container: Docker.Container;
    try {
      container = await this.docker.createContainer({
        name: containerName(sandboxId),
        Image: image ?? this.opts.baseImage,
        Cmd: ['sleep', 'infinity'],
        Labels: { [SANDBOX_LABEL]: sandboxId },
        HostConfig: {
          // The security set, none optional: gVisor keeps sandbox code off
          // the real kernel, Init reaps zombies, no-new-privileges blocks
          // setuid escalation, PidsLimit stops fork bombs. The image itself
          // runs as uid 1000 (user), never root.
          Runtime: 'runsc',
          Init: true,
          SecurityOpt: ['no-new-privileges'],
          NanoCpus: Math.round(this.opts.cpus * 1e9),
          Memory: Math.round(this.opts.memoryGb * 1024 ** 3),
          PidsLimit: this.opts.pidsLimit,
          Binds: [`${this.mountDir(sandboxId)}:/home/user`],
          // Life and death belong to the daemon's state machine; Docker
          // must not resurrect anything on its own.
          RestartPolicy: { Name: 'no' },
        },
      });
    } catch (err) {
      // Name collision race between our inspect and createContainer.
      if (isDockerApiError(err) && err.statusCode === 409) {
        throw new Error(`container ${sandboxId} already exists`);
      }
      // Registration never checks image existence (the image may arrive
      // later), so this is where a missing one honestly surfaces. Named
      // here — dockerode's own 404 would otherwise leak out as this API's
      // "sandbox not found" status.
      if (isDockerApiError(err) && err.statusCode === 404) {
        throw new Error(
          `image ${image ?? this.opts.baseImage} is not on this host — docker pull or build it, then retry`,
        );
      }
      throw err;
    }
    await container.start();
  }

  /**
   * The sandbox disk: a sparse file (promises diskSizeGb, occupies what is
   * actually written — the physical basis of overselling) formatted as ext4
   * and loop-mounted. Benchmarked 2026-07-08: worst-case tax ≈ 0.
   */
  private async provisionDisk(sandboxId: string): Promise<void> {
    const img = this.imagePath(sandboxId);
    const mnt = this.mountDir(sandboxId);
    await mkdir(path.dirname(img), { recursive: true });
    await mkdir(mnt, { recursive: true });
    const file = await open(img, 'w');
    try {
      await file.truncate(this.opts.diskSizeGb * 1024 ** 3);
    } finally {
      await file.close();
    }
    // -F: the target is a regular file, not a block device — skip the
    // interactive "proceed anyway?" prompt no one is there to answer.
    await execa('mkfs.ext4', ['-q', '-F', img]);
    await execa('mount', ['-o', 'loop,discard', img, mnt]);
    // Born fully owned by the in-container user (uid 1000): the fs root and
    // mkfs's lost+found — root:0700 otherwise, which uid-1000 file plumbing
    // cannot descend into (find at depth ≥ 2 exits 1). Only safe at birth;
    // once a sandbox has run, disk content is sandbox-controlled and the
    // host must not touch it (ensureMounted deliberately never chowns).
    await chown(mnt, 1000, 1000);
    await chown(path.join(mnt, 'lost+found'), 1000, 1000);
  }

  /** Idempotent: mounts the sandbox disk unless it already is mounted. */
  private async ensureMounted(sandboxId: string): Promise<void> {
    const mnt = this.mountDir(sandboxId);
    await mkdir(mnt, { recursive: true });
    const check = await execa('mountpoint', ['-q', mnt], { reject: false });
    if (check.exitCode !== 0) {
      await execa('mount', [
        '-o',
        'loop,discard',
        this.imagePath(sandboxId),
        mnt,
      ]);
    }
  }

  private async teardownDisk(sandboxId: string): Promise<void> {
    const img = this.imagePath(sandboxId);
    const mnt = this.mountDir(sandboxId);
    assertInside(this.opts.dataDir, img);
    assertInside(this.opts.dataDir, mnt);
    // Unmount may fail because nothing is mounted (e.g. after a reboot);
    // that is fine — the goal is only that rm below removes a plain dir.
    await execa('umount', [mnt], { reject: false });
    await rm(img, { force: true });
    await rm(mnt, { recursive: true, force: true });
  }

  /**
   * Looks the sandbox's container up by name. Returns the container id
   * (needed for cgroup paths, which want the full id, not the name) and
   * Docker's raw status, or null if no such container exists.
   */
  private async inspect(
    sandboxId: string,
  ): Promise<{ id: string; status: string } | null> {
    try {
      const info = await this.docker
        .getContainer(containerName(sandboxId))
        .inspect();
      return { id: info.Id, status: info.State.Status };
    } catch (err) {
      if (isDockerApiError(err) && err.statusCode === 404) return null;
      throw err;
    }
  }

  /**
   * Verifies the container is in the state the operation needs, throwing
   * the same message the fake throws — the two implementations must be
   * indistinguishable to callers, and the contract tests hold them to it.
   */
  private async expectState(
    sandboxId: string,
    wanted: ContainerState,
  ): Promise<string> {
    let actual: ContainerState | undefined;
    let containerId: string | null = null;
    try {
      const info = await this.docker
        .getContainer(containerName(sandboxId))
        .inspect();
      containerId = info.Id;
      actual = containerStateFromDocker(info.State.Status);
    } catch (err) {
      if (!isDockerApiError(err) || err.statusCode !== 404) throw err;
    }
    if (containerId === null || actual !== wanted) {
      throw new Error(
        `container ${sandboxId} is ${actual ?? 'absent'}, expected ${wanted}`,
      );
    }
    return containerId;
  }

  /**
   * Squeezes the paused container's memory out to swap — the second half of
   * freezing, what makes idle actually free.
   *
   * The number-one trap (measured 2026-07-07, kernel 6.8): writing more than
   * is actually reclaimable makes the kernel retry-scan for minutes with the
   * writer stuck unkillable. Two safety nets, both mandatory: write the
   * observed memory.current value (never a blind large number), and write
   * from a subprocess with a SIGKILL timeout — Node's own fs.writeFile would
   * wedge a thread-pool thread that nothing can kill. Hitting the timeout is
   * expected, not an error: the bulk is squeezed out within seconds and the
   * tail was never reclaimable to begin with.
   */
  private async reclaimMemory(containerId: string): Promise<void> {
    const dir = `/sys/fs/cgroup/system.slice/docker-${containerId}.scope`;
    try {
      await access(dir);
    } catch {
      this.log(`cgroup dir missing, skipping memory reclaim: ${dir}`);
      return;
    }
    const current = Number(
      (await readFile(`${dir}/memory.current`, 'utf8')).trim(),
    );
    if (!Number.isFinite(current) || current < 16 * 1024 * 1024) {
      return; // Less than 16MB is not worth squeezing.
    }
    try {
      await execa('sh', ['-c', `echo ${current} > ${dir}/memory.reclaim`], {
        timeout: this.opts.reclaimTimeoutSeconds * 1000,
        killSignal: 'SIGKILL',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`memory.reclaim cut short (expected): ${msg}`);
    }
    try {
      const after = Number(
        (await readFile(`${dir}/memory.current`, 'utf8')).trim(),
      );
      this.log(
        `reclaimed: ${(current / 1024 ** 2).toFixed(1)}MiB -> ${(after / 1024 ** 2).toFixed(1)}MiB`,
      );
    } catch {
      // Only a log line; unreadable is fine.
    }
  }
}
