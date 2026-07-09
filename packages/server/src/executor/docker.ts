import { randomUUID } from 'node:crypto';
import {
  access,
  chown,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { Writable } from 'node:stream';
import {
  EXEC_OUTPUT_LIMIT_BYTES,
  FILE_SIZE_LIMIT_BYTES,
  resolveSandboxPath,
} from '@dormice/shared';
import Docker from 'dockerode';
import { execa } from 'execa';
import {
  type ContainerState,
  DiskFullError,
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
 * In-container deadline for file operations, same mechanism as exec's
 * (host-side disconnects cannot kill an in-container process). Not a user
 * knob: 16 MiB on a local ext4 is subsecond work — this guard only exists
 * so a pathological target cannot hang the daemon's request forever.
 */
const FILE_OP_TIMEOUT_SECONDS = 60;

/**
 * The file-op scripts talk back through exit codes of our choosing — private
 * numbers between the daemon and its own script, no user command runs inside.
 * They map 1:1 onto the typed file errors both executors must throw.
 */
const NO_SUCH_FILE_EXIT = 44;
const NOT_A_FILE_EXIT = 45;
const TOO_LARGE_EXIT = 46;

/**
 * $1 = absolute path. Refuses a target that exists but is not a regular
 * file (directory, FIFO — `cat >` into a FIFO would block forever), creates
 * the parents, then streams stdin into the file. Runs as uid 1000, so
 * in-sandbox permissions apply honestly, and path resolution — symlinks
 * included — happens inside the container, where there is no host to
 * escape to.
 */
const WRITE_FILE_SCRIPT = [
  `[ ! -e "$1" ] || [ -f "$1" ] || exit ${NOT_A_FILE_EXIT}`,
  'mkdir -p -- "$(dirname -- "$1")" && exec cat > "$1"',
].join('\n');

/** $1 = absolute path, $2 = size limit in bytes. Size gate before content: an over-limit file is refused, never truncated. */
const READ_FILE_SCRIPT = [
  `[ -e "$1" ] || exit ${NO_SUCH_FILE_EXIT}`,
  `[ -f "$1" ] || exit ${NOT_A_FILE_EXIT}`,
  'size=$(stat -c %s -- "$1") || exit 1',
  `[ "$size" -le "$2" ] || { echo "$size" >&2; exit ${TOO_LARGE_EXIT}; }`,
  'exec cat -- "$1"',
].join('\n');

const NOT_A_DIR_EXIT = 47;
const ALREADY_EXISTS_EXIT = 48;

/**
 * Streaming file transfers have no size cap, so their in-container deadline
 * must fit a quota-sized file crawling to a slow client — generous, but
 * still a bound so a wedged transfer cannot hold an exec forever.
 */
const STREAM_FILE_OP_TIMEOUT_SECONDS = 3600;

/** Ceiling for one directory listing; past it the listing errors instead of silently losing entries. */
const LIST_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

/** $1 = absolute path. READ_FILE_SCRIPT without the size gate — the streaming read is the uncapped path. */
const READ_FILE_STREAM_SCRIPT = [
  `[ -e "$1" ] || exit ${NO_SUCH_FILE_EXIT}`,
  `[ -f "$1" ] || exit ${NOT_A_FILE_EXIT}`,
  'exec cat -- "$1"',
].join('\n');

/**
 * $1 = absolute dir, $2 = depth. One NUL-terminated record per entry, tab
 * separated with the path last, so a path containing tabs still parses
 * (nothing else can contain a tab, and a path cannot contain a NUL).
 */
const LIST_DIR_SCRIPT = [
  `[ -e "$1" ] || exit ${NO_SUCH_FILE_EXIT}`,
  `[ -d "$1" ] || exit ${NOT_A_DIR_EXIT}`,
  `exec find "$1" -mindepth 1 -maxdepth "$2" -printf '%y\\t%s\\t%T@\\t%m\\t%u\\t%g\\t%p\\0'`,
].join('\n');

/** $1 = absolute path. --printf, not -c: only --printf interprets \t. */
const STAT_SCRIPT = [
  `[ -e "$1" ] || exit ${NO_SUCH_FILE_EXIT}`,
  `exec stat --printf '%F\\t%s\\t%Y\\t%a\\t%U\\t%G' -- "$1"`,
].join('\n');

/** $1 = absolute path. Exists (whatever it is) -> "already there", else mkdir -p. */
const MAKE_DIR_SCRIPT = [
  `[ ! -e "$1" ] || exit ${ALREADY_EXISTS_EXIT}`,
  'exec mkdir -p -- "$1"',
].join('\n');

/** $1 = source, $2 = destination. -T = rename(2) semantics: never "move into". */
const MOVE_SCRIPT = [
  `[ -e "$1" ] || exit ${NO_SUCH_FILE_EXIT}`,
  'exec mv -T -- "$1" "$2"',
].join('\n');

const REMOVE_SCRIPT = [
  `[ -e "$1" ] || exit ${NO_SUCH_FILE_EXIT}`,
  'exec rm -rf -- "$1"',
].join('\n');

/**
 * Wrapper every execStream command runs under, so the handle can signal it
 * later. $1 = pidfile, $2 = timeout seconds, $3 = the user's command.
 * The exec chain keeps the pid stable: the recorded $$ is the bash that
 * becomes `timeout`, and `setsid --wait` outside made that pid a fresh
 * process-group leader — one `kill -- -pid` reaps the command and all its
 * descendants (GNU timeout's own group-kill relies on the same pgid).
 * setsid needs --wait or the exec would observe the fork's instant exit 0.
 */
function execStreamWrapper(loginShell: boolean): string {
  const shell = loginShell ? 'bash -l -c' : 'bash -c';
  return [
    'echo "$$" > "$1"',
    `exec timeout --signal=KILL "$2" ${shell} "$3"`,
  ].join('\n');
}

/**
 * $1 = pidfile, $2 = signal name (SIGKILL/SIGTERM). The brief wait covers
 * the honest race of a signal arriving before the wrapper's first line has
 * written the pidfile. Group kill first; a leader that already died with
 * children lingering still gets the single-pid fallback.
 */
const SIGNAL_SCRIPT = [
  'for _ in $(seq 1 40); do [ -s "$1" ] && break; sleep 0.05; done',
  'p=$(cat "$1") || exit 1',
  '[ -n "$p" ] || exit 1',
  'kill -s "$2" -- "-$p" 2>/dev/null || exec kill -s "$2" "$p"',
].join('\n');

/**
 * $1 = pidfile. The PTY session: an interactive login shell, nothing else.
 * Deliberately no timeout wrapper (GNU timeout puts the child in its own
 * process group, which wrecks interactive job control with SIGTTIN) and no
 * setsid (a Tty exec is born session leader holding the controlling
 * terminal; setsid would take the terminal away). The shell's own group is
 * what the pidfile kill reaps; foreground jobs follow the closing pty
 * master via SIGHUP. Lifetime is bounded by the sandbox's own.
 */
const PTY_WRAPPER = ['echo "$$" > "$1"', 'exec bash -i -l'].join('\n');

/** One `find -printf` record (see LIST_DIR_SCRIPT) -> entry. */
function entryFromFindRecord(record: string): SandboxEntry {
  const fields = record.split('\t');
  const [kind = '', size = '', mtime = '', mode = '', owner = '', group = ''] =
    fields;
  // The path is everything after the sixth tab — its own tabs survive.
  const path = fields.slice(6).join('\t');
  return {
    name: path.slice(path.lastIndexOf('/') + 1) || '/',
    path,
    type: kind === 'f' ? 'file' : kind === 'd' ? 'dir' : 'other',
    sizeBytes: Number(size),
    modifiedTime: new Date(Number(mtime) * 1000).toISOString(),
    mode: Number.parseInt(mode, 8),
    owner,
    group,
  };
}

/** One `stat --printf` line (see STAT_SCRIPT) -> entry. */
function entryFromStatLine(resolved: string, line: string): SandboxEntry {
  const [kind = '', size = '', mtime = '', mode = '', owner = '', group = ''] =
    line.split('\t');
  return {
    name: resolved.slice(resolved.lastIndexOf('/') + 1) || '/',
    path: resolved,
    // %F says "regular file" or "regular empty file" — both are files.
    type: kind.startsWith('regular')
      ? 'file'
      : kind === 'directory'
        ? 'dir'
        : 'other',
    sizeBytes: Number(size),
    modifiedTime: new Date(Number(mtime) * 1000).toISOString(),
    mode: Number.parseInt(mode, 8),
    owner,
    group,
  };
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

/**
 * A Writable that keeps the first `cap` bytes and drains the rest. Draining
 * is the point: if the sink stopped acknowledging chunks past the cap,
 * backpressure would wedge the exec stream and the command with it.
 */
class CappedBuffer extends Writable {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly cap: number) {
    super();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: () => void,
  ): void {
    const room = this.cap - this.size;
    if (room > 0) {
      const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
      this.chunks.push(kept);
      this.size += kept.length;
    }
    if (chunk.length > room) this.truncated = true;
    callback();
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }

  text(): string {
    return this.bytes().toString('utf8');
  }
}

/**
 * A Writable that hands each chunk to a callback — the streaming sink for
 * exec output and file downloads. When the callback returns a promise it is
 * awaited before the next chunk is accepted: that is how a slow consumer's
 * backpressure travels through demux all the way to the in-container writer.
 */
class CallbackSink extends Writable {
  constructor(
    private readonly onChunk: (chunk: Buffer) => void | Promise<void>,
  ) {
    super();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    Promise.resolve()
      .then(() => this.onChunk(chunk))
      .then(
        () => callback(),
        (err) => callback(err instanceof Error ? err : new Error(String(err))),
      );
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

  async create(sandboxId: string): Promise<void> {
    if ((await this.inspect(sandboxId)) !== null) {
      throw new Error(`container ${sandboxId} already exists`);
    }
    await this.provisionDisk(sandboxId);
    await this.launchContainer(sandboxId);
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

  async start(sandboxId: string): Promise<void> {
    const found = await this.inspect(sandboxId);
    if (found === null) {
      // The container object is gone — a routine `docker container prune`
      // eats exited containers — but the disk survives, and the disk is the
      // sandbox's data. Rebuild the replaceable shell around it.
      if (!(await this.diskExists(sandboxId))) {
        throw new Error(`disk ${sandboxId} is absent, cannot start`);
      }
      await this.ensureMounted(sandboxId);
      await this.launchContainer(sandboxId);
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
    const container = this.docker.getContainer(found.id);
    // Walk the container down ourselves instead of leaning on remove's
    // force-kill: dockerd cannot deliver a signal into a paused gVisor
    // sandbox and burns a hard-coded 10s wait before escalating (measured
    // 2026-07-09, sometimes erroring "PID is zombie"). Unpause so the kill
    // lands, then wait for the actual exit before removing.
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
    await this.teardownDisk(sandboxId);
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
        'setsid',
        '--wait',
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
        await this.signalProcess(container, sandboxId, pidfile, sig);
      },
      resizePty: async () => {
        throw new Error('process has no PTY');
      },
    };
  }

  /** Delivers a signal to an execStream'd process group via its pidfile. */
  private async signalProcess(
    container: Docker.Container,
    sandboxId: string,
    pidfile: string,
    sig: 'SIGTERM' | 'SIGKILL',
  ): Promise<void> {
    const run = await this.runInContainer(container, sandboxId, {
      cmd: ['bash', '-c', SIGNAL_SCRIPT, 'bash', pidfile, sig],
      outputCap: EXEC_OUTPUT_LIMIT_BYTES,
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
      User: 'user',
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
        await this.signalProcess(container, sandboxId, pidfile, sig);
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

  async writeFiles(sandboxId: string, files: FileToWrite[]): Promise<void> {
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

  async readFile(sandboxId: string, path: string): Promise<Buffer> {
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

  async statEntry(sandboxId: string, path: string): Promise<SandboxEntry> {
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

  async makeDir(sandboxId: string, path: string): Promise<boolean> {
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
    });
    if (run.exitCode === NO_SUCH_FILE_EXIT) {
      throw new FileNotFoundError(`no such file: ${source}`);
    }
    if (run.exitCode !== 0) {
      throw new Error(
        `moving ${source} to ${destination} in ${sandboxId} failed (exit ${run.exitCode}): ${run.stderr.text().trim()}`,
      );
    }
    return this.statEntry(sandboxId, destination);
  }

  async remove(sandboxId: string, path: string): Promise<void> {
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
      User: 'user',
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
   * and start() (rebuild after the container object was lost).
   */
  private async launchContainer(sandboxId: string): Promise<void> {
    let container: Docker.Container;
    try {
      container = await this.docker.createContainer({
        name: containerName(sandboxId),
        Image: this.opts.baseImage,
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
