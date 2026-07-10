import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  EXEC_OUTPUT_LIMIT_BYTES,
  FILE_SIZE_LIMIT_BYTES,
  resolveSandboxPath,
} from '@dormice/shared';
import {
  type ContainerState,
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
  type WatchDirHandle,
  type WatchDirOptions,
  type WatchEvent,
} from './executor';

/**
 * Directories every real sandbox is born with, with the owner and mode
 * reality gives them: the image's skeleton plus lost+found — the mkfs.ext4
 * artifact every disk carries in its root (/home/user), which a directory
 * listing must therefore show on the fake too. lost+found belongs to the
 * user because provisionDisk chowns it at disk birth.
 */
const BUILTIN_DIRS: Record<string, { owner: string; mode: number }> = {
  '/': { owner: 'root', mode: 0o755 },
  '/home': { owner: 'root', mode: 0o755 },
  '/home/user': { owner: 'user', mode: 0o755 },
  '/home/user/lost+found': { owner: 'user', mode: 0o700 },
  '/tmp': { owner: 'root', mode: 0o1777 },
};

/**
 * The fake disk's content: one node per path, directories materialized —
 * mkdir -p on a real disk leaves real directories behind, so the model
 * does too (an earlier implicit-directory model could not answer makeDir
 * on an empty directory or list one).
 */
type FakeNode =
  | { type: 'file'; content: Buffer; modifiedTime: string }
  | { type: 'dir'; modifiedTime: string };

function seededDisk(): Map<string, FakeNode> {
  const now = new Date().toISOString();
  return new Map(
    Object.keys(BUILTIN_DIRS).map((path) => [
      path,
      { type: 'dir' as const, modifiedTime: now },
    ]),
  );
}

/**
 * Node -> entry, with the metadata reality would report: files land as
 * uid 1000 with the default umask (644), created directories as 755, and
 * the built-in skeleton keeps the image's own owners and modes.
 */
function entryFor(path: string, node: FakeNode): SandboxEntry {
  const meta =
    node.type === 'dir'
      ? (BUILTIN_DIRS[path] ?? { owner: 'user', mode: 0o755 })
      : { owner: 'user', mode: 0o644 };
  return {
    name: path.slice(path.lastIndexOf('/') + 1) || '/',
    path,
    type: node.type,
    // 4096 = one ext4 block, what a real directory stats as.
    sizeBytes: node.type === 'file' ? node.content.length : 4096,
    modifiedTime: node.modifiedTime,
    mode: meta.mode,
    owner: meta.owner,
    group: meta.owner,
  };
}

/**
 * One live fake watcher: a subscription on the fake disk's mutation funnels.
 * Events chain through `queue` so a slow onEvent (backpressure) never
 * reorders deliveries — the same serialization the real executor gets from
 * reading inotifywait's pipe line by line.
 */
interface FakeWatcher {
  base: string;
  recursive: boolean;
  onEvent: (event: WatchEvent) => void | Promise<void>;
  onEnd: (error?: Error) => void;
  stopped: boolean;
  queue: Promise<void>;
}

/**
 * The live half of a fake process: a stdin mailbox and a kill switch. The
 * interpreter reads the mailbox (cat), sleeps interruptibly against the
 * kill promise, and the handle's verbs write into it — the same decoupling
 * of process from stream the real executor gets from the hijacked duplex.
 */
class FakeProcessIO {
  private queue: Buffer[] = [];
  private stdinClosed = false;
  private wakeups: Array<() => void> = [];
  killSignal: 'SIGTERM' | 'SIGKILL' | undefined;
  /** Present in PTY mode; resizePty rewrites it, `stty size` reads it. */
  ptySize?: PtySize;
  private killResolve!: (exitCode: number) => void;
  /** Settles with the signal's exit code (KILL 137, TERM 143) when killed. */
  readonly killed = new Promise<number>((resolve) => {
    this.killResolve = resolve;
  });

  pushStdin(data: Buffer): void {
    if (this.stdinClosed) throw new Error('stdin is closed');
    this.queue.push(data);
    this.wake();
  }

  closeStdin(): void {
    if (this.stdinClosed) throw new Error('stdin is closed');
    this.stdinClosed = true;
    this.wake();
  }

  kill(sig: 'SIGTERM' | 'SIGKILL'): void {
    if (this.killSignal) return;
    this.killSignal = sig;
    this.killResolve(sig === 'SIGKILL' ? 137 : 143);
    this.wake();
  }

  /** Next stdin chunk; null is EOF — closeStdin's or the kill's. */
  async nextStdin(): Promise<Buffer | null> {
    while (true) {
      const chunk = this.queue.shift();
      if (chunk) return chunk;
      if (this.stdinClosed || this.killSignal) return null;
      await new Promise<void>((resolve) => this.wakeups.push(resolve));
    }
  }

  /** Sleeps, but a kill cuts it short — a real sleep dies to SIGKILL too. */
  async sleep(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      this.killed,
    ]);
    clearTimeout(timer);
  }

  private wake(): void {
    const pending = this.wakeups;
    this.wakeups = [];
    for (const resolve of pending) resolve();
  }
}

/**
 * In-memory stand-in for the Docker+gVisor executor. Not a throwaway: it is
 * the permanent test double — unit tests and local development run on it;
 * only the e2e suite on a Linux machine exercises the real one.
 *
 * Deliberately strict: every method checks the state a real container would
 * have to be in, so a caller that would break against Docker breaks against
 * the fake too.
 */
export class FakeExecutor implements Executor {
  private readonly containers = new Map<string, ContainerState>();
  private readonly disks = new Set<string>();
  /**
   * Live processes per sandbox. stop/destroy/vanish kill them — on the real
   * executor the container's death takes every exec with it, and the fake
   * must conduct the same physics or the process table above it would leak.
   */
  private readonly procs = new Map<string, Set<FakeProcessIO>>();
  /**
   * Lazy per-sandbox upstream servers behind resolvePortTarget — the fake's
   * only real socket, and the price of exercising the sandbox proxy end to
   * end without Docker. Each echoes what it received as JSON; upgrades get
   * a bare 101 and their bytes echoed back.
   */
  private readonly upstreams = new Map<string, http.Server>();
  /**
   * Keyed like disks, not containers: files are the disk's content, so they
   * survive stop, start, and a vanished container object, and die only when
   * the disk does. That is the "the disk is the sandbox's body" invariant,
   * modeled where it physically lives.
   */
  private readonly fs = new Map<string, Map<string, FakeNode>>();
  /**
   * Live watchers per sandbox. Keyed like processes, not disks: a watcher
   * is a running inotifywait on the real executor, so the container's death
   * ends it even though the files it watched survive.
   */
  private readonly watchers = new Map<string, Set<FakeWatcher>>();

  /** Test hook: what does "reality" say about this sandbox? */
  stateOf(sandboxId: string): ContainerState | undefined {
    return this.containers.get(sandboxId);
  }

  /**
   * Test hook: the container disappears, the disk stays — a removal behind
   * the daemon's back, or a crash in the middle of destroy. The one-sided
   * drift the fake cannot produce by crashing for real.
   */
  vanishContainer(sandboxId: string): void {
    if (!this.containers.delete(sandboxId)) {
      throw new Error(`container ${sandboxId} is absent, cannot vanish`);
    }
    this.killProcesses(sandboxId);
  }

  /**
   * Test hook: a disk with no container and no row — a crash between
   * provisioning the disk and creating the container.
   */
  plantDiskResidue(sandboxId: string): void {
    this.disks.add(sandboxId);
  }

  async create(sandboxId: string): Promise<void> {
    if (this.containers.has(sandboxId)) {
      throw new Error(`container ${sandboxId} already exists`);
    }
    this.disks.add(sandboxId);
    this.fs.set(sandboxId, seededDisk());
    this.containers.set(sandboxId, 'running');
  }

  async freeze(sandboxId: string): Promise<void> {
    this.expect(sandboxId, 'running');
    this.containers.set(sandboxId, 'paused');
  }

  async unfreeze(sandboxId: string): Promise<void> {
    this.expect(sandboxId, 'paused');
    this.containers.set(sandboxId, 'running');
  }

  async stop(sandboxId: string): Promise<void> {
    this.expect(sandboxId, 'paused');
    this.containers.set(sandboxId, 'stopped');
    this.killProcesses(sandboxId);
  }

  async start(sandboxId: string): Promise<void> {
    const actual = this.containers.get(sandboxId);
    if (actual === undefined) {
      // The container object is gone (pruned, removed behind the daemon's
      // back) but the disk survives — and the disk is the sandbox's data,
      // the container just a replaceable shell. Rebuild around the disk.
      if (!this.disks.has(sandboxId)) {
        throw new Error(`disk ${sandboxId} is absent, cannot start`);
      }
      this.containers.set(sandboxId, 'running');
      return;
    }
    this.expect(sandboxId, 'stopped');
    this.containers.set(sandboxId, 'running');
  }

  async destroy(sandboxId: string): Promise<void> {
    // Any state is fine, and so is a container that is already gone as long
    // as the disk remains (a pruned stopped sandbox): destroy promises
    // "container and disk gone", and half-gone still needs the other half.
    // Both absent means the ledger and reality disagree — a bug worth
    // hearing.
    const hadContainer = this.containers.delete(sandboxId);
    const hadDisk = this.disks.delete(sandboxId);
    this.fs.delete(sandboxId);
    this.killProcesses(sandboxId);
    this.closeUpstream(sandboxId);
    if (!hadContainer && !hadDisk) {
      throw new Error(`container ${sandboxId} is absent, cannot destroy`);
    }
  }

  async removeContainer(sandboxId: string): Promise<void> {
    // Any state goes; an already-gone container is the goal state as long
    // as the disk remains. Both absent is destroy's same complaint: the
    // ledger points at nothing. The disk — and with it the files — stays
    // untouched: that is the entire point of the verb.
    const hadContainer = this.containers.delete(sandboxId);
    if (!hadContainer && !this.disks.has(sandboxId)) {
      throw new Error(`container ${sandboxId} is absent, cannot remove`);
    }
    // The container's death takes every process and watcher with it, same
    // physics as stop and vanish.
    this.killProcesses(sandboxId);
  }

  async listContainers(): Promise<Map<string, ContainerState>> {
    // A copy: reality is observed, not handed out by reference.
    return new Map(this.containers);
  }

  async listDisks(): Promise<string[]> {
    return [...this.disks];
  }

  async removeDisk(sandboxId: string): Promise<void> {
    // Idempotent by contract: an absent disk already is the goal state.
    this.disks.delete(sandboxId);
    this.fs.delete(sandboxId);
    this.closeUpstream(sandboxId);
  }

  async resolvePortTarget(
    sandboxId: string,
    port: number,
  ): Promise<{ host: string; port: number }> {
    this.expect(sandboxId, 'running');
    let server = this.upstreams.get(sandboxId);
    if (!server) {
      const upstream = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            sandboxId,
            method: req.method,
            path: req.url,
            host: req.headers.host ?? null,
          }),
        );
      });
      upstream.on('upgrade', (_req, socket) => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
        );
        socket.pipe(socket);
      });
      await new Promise<void>((resolve) =>
        upstream.listen(0, '127.0.0.1', resolve),
      );
      this.upstreams.set(sandboxId, upstream);
      server = upstream;
    }
    // One echo server stands in for every in-sandbox port: which port was
    // asked for still travels in the Host header the proxy preserves.
    void port;
    return { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  }

  private closeUpstream(sandboxId: string): void {
    this.upstreams.get(sandboxId)?.close();
    this.upstreams.delete(sandboxId);
  }

  async metrics(sandboxId: string): Promise<SandboxMetrics> {
    const actual = this.containers.get(sandboxId);
    if (actual !== 'running' && actual !== 'paused') {
      throw new Error(
        `container ${sandboxId} is ${actual ?? 'absent'}, expected running or paused`,
      );
    }
    // Disk usage is computed from the file table — the one number the
    // contract can watch move (write a file, usage grows) on both
    // executors; the rest are plausible constants in honest proportions.
    let diskUsedBytes = 0;
    for (const node of this.disk(sandboxId).values()) {
      diskUsedBytes += node.type === 'file' ? node.content.length : 4096;
    }
    return {
      cpuCount: 1,
      cpuUsedPct: 0,
      memUsedBytes: 64 * 1024 ** 2,
      memTotalBytes: 2 * 1024 ** 3,
      memCacheBytes: 0,
      diskUsedBytes,
      diskTotalBytes: 10 * 1024 ** 3,
    };
  }

  async exec(sandboxId: string, opts: ExecOptions): Promise<ExecResult> {
    const stdout = new CappedText(EXEC_OUTPUT_LIMIT_BYTES);
    const stderr = new CappedText(EXEC_OUTPUT_LIMIT_BYTES);
    const handle = await this.execStream(sandboxId, {
      command: opts.command,
      timeoutSeconds: opts.timeoutSeconds,
      cwd: opts.cwd,
      env: opts.env,
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk),
    });
    const { exitCode } = await handle.wait();
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  }

  async execStream(
    sandboxId: string,
    opts: ExecStreamOptions,
  ): Promise<ExecStreamHandle> {
    this.expect(sandboxId, 'running');
    const command = opts.command;
    if (opts.pty === undefined && command === undefined) {
      throw new Error('execStream needs a command unless pty is set');
    }
    const io = new FakeProcessIO();
    if (opts.pty) io.ptySize = { ...opts.pty };
    this.trackProcess(sandboxId, io);
    // The timeout and the kill switch race the interpreter, same outcomes
    // as the real executor's in-container `timeout --signal=KILL` and the
    // handle's signal(): 137/143. Chunks delivered before the kill stay
    // delivered — an emitted chunk cannot be unsent — and the flag silences
    // anything the losing interpreter emits afterwards.
    let silenced = false;
    const emit = {
      stdout: (text: string) => {
        if (!silenced) opts.onStdout(Buffer.from(text, 'utf8'));
      },
      stderr: (text: string) => {
        if (!silenced) opts.onStderr(Buffer.from(text, 'utf8'));
      },
    };
    let finished = false;
    const done = (async () => {
      // One macrotask of quiet: no output before execStream itself resolves
      // — the interface's promise to callers, which the real executor keeps
      // physically (I/O events cannot preempt the awaiting caller) and the
      // interpreter's synchronous first verb would otherwise break.
      await new Promise((resolve) => setImmediate(resolve));
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<number>((resolve) => {
        timer = setTimeout(() => {
          silenced = true;
          resolve(137);
        }, opts.timeoutSeconds * 1000);
      });
      const killed = io.killed.then((exitCode) => {
        silenced = true;
        return exitCode;
      });
      try {
        const run = opts.pty
          ? ptySession(opts, emit, io)
          : interpret({ ...opts, command: command as string }, emit, io);
        return {
          exitCode: await Promise.race([run, deadline, killed]),
        };
      } finally {
        clearTimeout(timer);
        this.untrackProcess(sandboxId, io);
        finished = true;
      }
    })();
    // A failure before anyone calls wait must not become an unhandled
    // rejection; wait() still observes it through the same promise.
    done.catch(() => {});
    return {
      wait: () => done,
      sendStdin: async (data) => {
        // A PTY implies an open stdin: the terminal IS an input channel.
        if (!opts.stdin && !opts.pty) {
          throw new Error('process was started without stdin');
        }
        io.pushStdin(data);
      },
      closeStdin: async () => {
        if (!opts.stdin && !opts.pty) {
          throw new Error('process was started without stdin');
        }
        io.closeStdin();
      },
      signal: async (sig) => {
        if (finished) throw new Error('process already exited');
        io.kill(sig);
      },
      resizePty: async (size) => {
        if (!opts.pty) throw new Error('process has no PTY');
        io.ptySize = { ...size };
      },
    };
  }

  private trackProcess(sandboxId: string, io: FakeProcessIO): void {
    const set = this.procs.get(sandboxId) ?? new Set();
    set.add(io);
    this.procs.set(sandboxId, set);
  }

  private untrackProcess(sandboxId: string, io: FakeProcessIO): void {
    this.procs.get(sandboxId)?.delete(io);
  }

  private killProcesses(sandboxId: string): void {
    const set = this.procs.get(sandboxId);
    if (set) for (const io of set) io.kill('SIGKILL');
    this.endWatchers(sandboxId);
  }

  /** The container died under the watchers — conduct it, like processes. */
  private endWatchers(sandboxId: string): void {
    const set = this.watchers.get(sandboxId);
    if (!set) return;
    this.watchers.delete(sandboxId);
    for (const watcher of set) {
      if (watcher.stopped) continue;
      watcher.stopped = true;
      watcher.onEnd(new Error('watcher stopped: its container died'));
    }
  }

  /** The mutation funnels report here; each watcher filters and enqueues. */
  private emitWatch(
    sandboxId: string,
    path: string,
    type: WatchEvent['type'],
  ): void {
    const set = this.watchers.get(sandboxId);
    if (!set) return;
    for (const watcher of set) {
      if (watcher.stopped) continue;
      const prefix = watcher.base === '/' ? '/' : `${watcher.base}/`;
      if (!path.startsWith(prefix)) continue;
      const name = path.slice(prefix.length);
      if (!watcher.recursive && name.includes('/')) continue;
      watcher.queue = watcher.queue.then(async () => {
        if (watcher.stopped) return;
        await watcher.onEvent({ name, type });
      });
      // A throwing onEvent must not silence the watcher or crash anything;
      // the real pipe reader shrugs the same way.
      watcher.queue = watcher.queue.catch(() => {});
    }
  }

  async watchDir(
    sandboxId: string,
    opts: WatchDirOptions,
  ): Promise<WatchDirHandle> {
    this.expect(sandboxId, 'running');
    const base = resolveSandboxPath(opts.path);
    const node = this.disk(sandboxId).get(base);
    if (!node) throw new FileNotFoundError(`no such file: ${base}`);
    if (node.type !== 'dir') {
      throw new NotADirectoryError(`not a directory: ${base}`);
    }
    const watcher: FakeWatcher = {
      base,
      recursive: opts.recursive,
      onEvent: opts.onEvent,
      onEnd: opts.onEnd,
      stopped: false,
      queue: Promise.resolve(),
    };
    const set = this.watchers.get(sandboxId) ?? new Set();
    set.add(watcher);
    this.watchers.set(sandboxId, set);
    return {
      stop: async () => {
        watcher.stopped = true;
        set.delete(watcher);
      },
    };
  }

  async writeFiles(sandboxId: string, files: FileToWrite[]): Promise<void> {
    this.expect(sandboxId, 'running');
    const disk = this.disk(sandboxId);
    for (const file of files) {
      // Copy on the way in: the caller's buffer is theirs to reuse.
      this.writeNode(
        sandboxId,
        disk,
        resolveSandboxPath(file.path),
        Buffer.from(file.content),
      );
    }
  }

  async readFile(sandboxId: string, path: string): Promise<Buffer> {
    const node = this.fileNode(sandboxId, resolveSandboxPath(path));
    if (node.content.length > FILE_SIZE_LIMIT_BYTES) {
      throw new FileTooLargeError(
        `file too large: ${resolveSandboxPath(path)} is ${node.content.length} bytes, limit ${FILE_SIZE_LIMIT_BYTES}`,
      );
    }
    return Buffer.from(node.content);
  }

  async readFileStream(
    sandboxId: string,
    path: string,
    onChunk: (chunk: Buffer) => void | Promise<void>,
  ): Promise<void> {
    // The uncapped path: no size gate, one chunk (the fake has no reason to
    // slice; chunking is the real pipe's business, not the contract's).
    const node = this.fileNode(sandboxId, resolveSandboxPath(path));
    await onChunk(Buffer.from(node.content));
  }

  async writeFileStream(
    sandboxId: string,
    path: string,
    content: NodeJS.ReadableStream,
  ): Promise<void> {
    this.expect(sandboxId, 'running');
    const disk = this.disk(sandboxId);
    const resolved = resolveSandboxPath(path);
    const chunks: Buffer[] = [];
    for await (const chunk of content) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.writeNode(sandboxId, disk, resolved, Buffer.concat(chunks));
  }

  async listDir(
    sandboxId: string,
    path: string,
    depth: number,
  ): Promise<SandboxEntry[]> {
    this.expect(sandboxId, 'running');
    const disk = this.disk(sandboxId);
    const base = resolveSandboxPath(path);
    const node = disk.get(base);
    if (!node) throw new FileNotFoundError(`no such file: ${base}`);
    if (node.type !== 'dir') {
      throw new NotADirectoryError(`not a directory: ${base}`);
    }
    const prefix = base === '/' ? '/' : `${base}/`;
    const entries: SandboxEntry[] = [];
    for (const [p, n] of disk) {
      if (p === base || !p.startsWith(prefix)) continue;
      if (p.slice(prefix.length).split('/').length > depth) continue;
      entries.push(entryFor(p, n));
    }
    return entries.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  }

  async statEntry(sandboxId: string, path: string): Promise<SandboxEntry> {
    this.expect(sandboxId, 'running');
    const resolved = resolveSandboxPath(path);
    const node = this.disk(sandboxId).get(resolved);
    if (!node) throw new FileNotFoundError(`no such file: ${resolved}`);
    return entryFor(resolved, node);
  }

  async makeDir(sandboxId: string, path: string): Promise<boolean> {
    this.expect(sandboxId, 'running');
    const disk = this.disk(sandboxId);
    const resolved = resolveSandboxPath(path);
    if (disk.has(resolved)) return false;
    const now = new Date().toISOString();
    this.ensureParents(sandboxId, disk, resolved);
    disk.set(resolved, { type: 'dir', modifiedTime: now });
    this.emitWatch(sandboxId, resolved, 'create');
    return true;
  }

  async move(
    sandboxId: string,
    from: string,
    to: string,
  ): Promise<SandboxEntry> {
    this.expect(sandboxId, 'running');
    const disk = this.disk(sandboxId);
    const source = resolveSandboxPath(from);
    const destination = resolveSandboxPath(to);
    const node = disk.get(source);
    if (!node) throw new FileNotFoundError(`no such file: ${source}`);
    if (BUILTIN_DIRS[source]) {
      // Reality refuses too (mount points, root-owned); wording untested.
      throw new Error(`moving ${source} failed: built-in directory`);
    }
    const destNode = disk.get(destination);
    if (destNode && (node.type === 'dir' || destNode.type === 'dir')) {
      // rename(2) only replaces a file with a file; everything else errors
      // on the real executor too (mv wording differs, untested by contract).
      throw new Error(
        `moving ${source} to ${destination} failed: destination exists`,
      );
    }
    const oldPrefix = `${source}/`;
    for (const [p, n] of [...disk]) {
      if (p !== source && !p.startsWith(oldPrefix)) continue;
      disk.delete(p);
      disk.set(destination + p.slice(source.length), n);
    }
    // inotify's move pair: RENAME fires on the old path, CREATE on the new
    // one (fsnotify's reading of MOVED_FROM/MOVED_TO); children move along
    // silently, exactly like the kernel's.
    this.emitWatch(sandboxId, source, 'rename');
    this.emitWatch(sandboxId, destination, 'create');
    return entryFor(destination, node);
  }

  async remove(sandboxId: string, path: string): Promise<void> {
    this.expect(sandboxId, 'running');
    const disk = this.disk(sandboxId);
    const resolved = resolveSandboxPath(path);
    const node = disk.get(resolved);
    if (!node) throw new FileNotFoundError(`no such file: ${resolved}`);
    if (BUILTIN_DIRS[resolved]) {
      // rm refuses / outright and cannot rmdir root-owned mount points;
      // wording differs from the real stderr, untested by contract.
      throw new Error(`removing ${resolved} failed: built-in directory`);
    }
    const prefix = `${resolved}/`;
    const deleted: string[] = [];
    for (const p of [...disk.keys()]) {
      if (p === resolved || p.startsWith(prefix)) {
        disk.delete(p);
        deleted.push(p);
      }
    }
    // rm -rf works depth-first, so inotify reports children before their
    // directory; deepest-first reproduces that order.
    deleted.sort((a, b) => b.length - a.length);
    for (const p of deleted) this.emitWatch(sandboxId, p, 'remove');
  }

  private disk(sandboxId: string): Map<string, FakeNode> {
    const disk = this.fs.get(sandboxId) ?? seededDisk();
    this.fs.set(sandboxId, disk);
    return disk;
  }

  /** The write path shared by buffered and streaming writes. */
  private writeNode(
    sandboxId: string,
    disk: Map<string, FakeNode>,
    resolved: string,
    content: Buffer,
  ): void {
    const existing = disk.get(resolved);
    if (existing?.type === 'dir') {
      throw new NotAFileError(`not a regular file: ${resolved}`);
    }
    this.ensureParents(sandboxId, disk, resolved);
    disk.set(resolved, {
      type: 'file',
      content,
      modifiedTime: new Date().toISOString(),
    });
    // A new file is CREATE then MODIFY through inotify; an overwrite is
    // MODIFY only (the real cat > truncates in place).
    if (!existing) this.emitWatch(sandboxId, resolved, 'create');
    this.emitWatch(sandboxId, resolved, 'write');
  }

  /** mkdir -p leaves real directories behind; so does the fake. */
  private ensureParents(
    sandboxId: string,
    disk: Map<string, FakeNode>,
    resolved: string,
  ): void {
    const segments = resolved.split('/').filter((s) => s !== '');
    let parent = '';
    for (const segment of segments.slice(0, -1)) {
      parent += `/${segment}`;
      const node = disk.get(parent);
      if (node === undefined) {
        disk.set(parent, {
          type: 'dir',
          modifiedTime: new Date().toISOString(),
        });
        this.emitWatch(sandboxId, parent, 'create');
      } else if (node.type !== 'dir') {
        // mkdir -p over a file fails on the real executor too (its stderr
        // wording differs; the contract does not pin this path).
        throw new Error(
          `cannot create parent directory ${parent} in ${sandboxId}: not a directory`,
        );
      }
    }
  }

  /** Node with the running-state and is-a-file checks every read shares. */
  private fileNode(
    sandboxId: string,
    resolved: string,
  ): Extract<FakeNode, { type: 'file' }> {
    this.expect(sandboxId, 'running');
    const node = this.disk(sandboxId).get(resolved);
    if (!node) throw new FileNotFoundError(`no such file: ${resolved}`);
    if (node.type !== 'file') {
      throw new NotAFileError(`not a regular file: ${resolved}`);
    }
    return node;
  }

  private expect(sandboxId: string, wanted: ContainerState): void {
    const actual = this.containers.get(sandboxId);
    if (actual !== wanted) {
      throw new Error(
        `container ${sandboxId} is ${actual ?? 'absent'}, expected ${wanted}`,
      );
    }
  }
}

/**
 * Truncation lives in this single sink so the buffered exec obeys the
 * protocol cap however the interpreter chunks its output. The interpreter
 * only ever emits ASCII, so string length equals byte length and slice()
 * is an honest byte cap.
 */
class CappedText {
  text = '';
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    const s = chunk.toString('utf8');
    const room = this.cap - this.text.length;
    if (room > 0) this.text += s.slice(0, room);
    if (s.length > room) this.truncated = true;
  }
}

interface Emit {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * The fake terminal: echoes input raw (a real tty with echo on does), cuts
 * lines on \r or \n, feeds each line to the pocket interpreter with stderr
 * merged into stdout (a terminal is one stream). `exit` ends the session;
 * `stty size` reads the size resizePty last wrote — the resize contract's
 * observation window. No fabricated prompt: real bash brings PS1 and
 * escape sequences, so the contract asserts with contains, never equals.
 */
async function ptySession(
  opts: { cwd?: string; env?: Record<string, string> },
  emit: Emit,
  io: FakeProcessIO,
): Promise<number> {
  const merged: Emit = { stdout: emit.stdout, stderr: emit.stdout };
  let line = '';
  while (true) {
    const chunk = await io.nextStdin();
    if (chunk === null) return 0;
    const text = chunk.toString('utf8');
    emit.stdout(text);
    line += text;
    while (true) {
      const cut = line.search(/[\r\n]/);
      if (cut === -1) break;
      const commandLine = line.slice(0, cut).trim();
      line = line.slice(cut + 1);
      if (commandLine === '') continue;
      if (commandLine === 'exit') return 0;
      if (commandLine === 'stty size') {
        const size = io.ptySize ?? { cols: 80, rows: 24 };
        emit.stdout(`${size.rows} ${size.cols}\n`);
        continue;
      }
      await interpret(
        { command: commandLine, cwd: opts.cwd, env: opts.env },
        merged,
        io,
      );
    }
  }
}

/**
 * A pocket bash: the seven verbs plus `;` sequencing — exactly what the
 * contract exam and the e2e suite need to exercise exec through the same
 * questions the real executor answers, nothing more. Each verb's output is
 * its own live chunk (the contract's streaming questions time the gaps).
 * Not a shell — an unknown verb gets bash's honest 127 and, like bash, the
 * sequence carries on; `exit` ends it. If the real bash's wording ever
 * proves different on the test machine, this string yields: reality wins.
 */
async function interpret(
  opts: { command: string; cwd?: string; env?: Record<string, string> },
  emit: Emit,
  io: FakeProcessIO,
): Promise<number> {
  let exitCode = 0;
  for (const segment of opts.command.split(';')) {
    const command = segment.trim();
    if (command === '') continue;
    const exited = command.match(/^exit (\d+)$/)?.[1];
    if (exited !== undefined) return Number(exited);
    exitCode = await interpretVerb(command, opts, emit, io);
  }
  return exitCode;
}

async function interpretVerb(
  command: string,
  opts: { cwd?: string; env?: Record<string, string> },
  emit: Emit,
  io: FakeProcessIO,
): Promise<number> {
  const echoed = command.match(/^echo (.*)$/s)?.[1];
  if (echoed !== undefined) {
    emit.stdout(`${echoed}\n`);
    return 0;
  }
  const napSeconds = command.match(/^sleep (\d+(?:\.\d+)?)$/)?.[1];
  if (napSeconds !== undefined) {
    // A real timer on purpose: e2e races this against the daemon's
    // wall-clock idle scanner to prove the exec heartbeat works, and the
    // contract's streaming questions time the chunk gap it creates.
    // Interruptible, because a real sleep dies to the handle's SIGKILL.
    await io.sleep(Number(napSeconds) * 1000);
    return 0;
  }
  if (command === 'cat') {
    // The stdin verb: echoes the mailbox chunk by chunk until EOF — the
    // whole sendStdin/closeStdin contract observable through one command.
    while (true) {
      const chunk = await io.nextStdin();
      if (chunk === null) return 0;
      emit.stdout(chunk.toString('utf8'));
    }
  }
  if (command === 'pwd') {
    emit.stdout(`${opts.cwd ?? '/home/user'}\n`);
    return 0;
  }
  const envKey = command.match(/^printenv (\w+)$/)?.[1];
  if (envKey !== undefined) {
    const value = opts.env?.[envKey];
    if (value === undefined) return 1;
    emit.stdout(`${value}\n`);
    return 0;
  }
  const seqEnd = command.match(/^seq 1 (\d+)$/)?.[1];
  if (seqEnd !== undefined) {
    let out = '';
    for (let i = 1; i <= Number(seqEnd); i++) out += `${i}\n`;
    emit.stdout(out);
    return 0;
  }
  const verb = command.split(/\s/)[0];
  emit.stderr(`bash: line 1: ${verb}: command not found\n`);
  return 127;
}
