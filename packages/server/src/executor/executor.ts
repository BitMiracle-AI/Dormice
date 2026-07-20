/**
 * What a container runtime can observe about a container. Coarser than the
 * ledger's five lifecycle states on purpose: reality knows nothing about
 * `archived` or `restoring` — those live in the ledger and S3.
 */
export type ContainerState = 'running' | 'paused' | 'stopped';

export interface ExecOptions {
  /** A shell string, executed as `bash -c <command>` inside the sandbox. */
  command: string;
  /**
   * In-container deadline. Enforced inside the sandbox — a host-side
   * disconnect cannot kill the in-container process; only an in-container
   * SIGKILL can. On expiry the command dies with exit 137.
   */
  timeoutSeconds: number;
  /** Working directory inside the sandbox; defaults to the image's /home/user. */
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Unix user the command runs as; defaults to 'user' (uid 1000). The
   * executor passes the name through to the runtime verbatim — which names
   * are allowed is the wire layer's decision, not modeled here. In-sandbox
   * root is contained by gVisor exactly like any other sandbox code.
   */
  user?: string;
}

export interface ExecResult {
  /** Honest exit code — a nonzero exit is a result, not an error. */
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** Terminal dimensions, the shape Process/Update's resize speaks. */
export interface PtySize {
  cols: number;
  rows: number;
}

export interface ExecStreamOptions {
  /**
   * A shell string, executed as `bash -c <command>` inside the sandbox.
   * Required unless `pty` is set — a PTY session is an interactive shell,
   * not a one-shot command.
   */
  command?: string;
  /**
   * Same in-container deadline as ExecOptions; on expiry exit 137. A PTY
   * session ignores it (GNU timeout's process-group games break interactive
   * job control); its lifetime is bounded by the sandbox's own.
   */
  timeoutSeconds: number;
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Run under a login shell (`bash -l -c`), which loads the image's profile
   * — the E2B surface's habit. The native API keeps plain `bash -c`; each
   * protocol stays true to its own contract.
   */
  loginShell?: boolean;
  /**
   * Keep stdin open for the handle's sendStdin/closeStdin. Absent means the
   * command starts with stdin already at EOF (the old behavior); the handle
   * verbs then refuse honestly instead of writing into nothing. A PTY
   * implies an open stdin — the terminal IS an input channel.
   */
  stdin?: boolean;
  /**
   * Start an interactive login shell (`bash -i -l`) on a pseudo-terminal of
   * this size instead of running `command`. Output is one merged raw tty
   * byte stream through onStdout; onStderr never fires. Input goes through
   * sendStdin, the size through resizePty.
   */
  pty?: PtySize;
  /** Same as ExecOptions.user; applies to PTY sessions too. */
  user?: string;
  /**
   * Called with each output chunk as it arrives. No cap: nothing accumulates
   * server-side. A returned promise MAY be awaited before the next chunk
   * (the real executor does — backpressure travels to the container; the
   * fake's in-memory source has nothing to press back on).
   * Never called before execStream itself resolves: the caller gets to
   * finish its own bookkeeping (write a wire start frame, register the
   * process) knowing no output has slipped past it.
   */
  onStdout: (chunk: Buffer) => void | Promise<void>;
  onStderr: (chunk: Buffer) => void | Promise<void>;
}

/**
 * A started command. Obtaining the handle means the exec is running; wait()
 * is its result. The management verbs exist on every handle and refuse
 * honestly when they do not apply — their refusal messages are part of the
 * executor contract, because the E2B surface forwards them to clients.
 */
export interface ExecStreamHandle {
  wait(): Promise<{ exitCode: number }>;
  /**
   * Writes into the command's stdin. Requires the command to have been
   * started with `stdin: true` (else: "process was started without stdin");
   * after closeStdin it refuses with "stdin is closed". A resolved promise
   * means the bytes are on their way to the in-container reader.
   */
  sendStdin(data: Buffer): Promise<void>;
  /** Delivers EOF to the command's stdin. Same refusals as sendStdin. */
  closeStdin(): Promise<void>;
  /**
   * Delivers a signal to the command's whole process group — SIGKILL lands
   * as exit 137 through wait(), SIGTERM as 143 (unless caught). Rejects when
   * the process has already finished; that wording is not contract-pinned.
   */
  signal(sig: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  /**
   * Resizes the command's pseudo-terminal. Refuses with "process has no PTY"
   * for a plain command — PTY sessions arrive with the pty exec option.
   */
  resizePty(size: PtySize): Promise<void>;
}

export interface FileToWrite {
  /** Absolute, or relative to /home/user — resolveSandboxPath's rules. */
  path: string;
  content: Buffer;
}

/** A byte span of a file, both bounds resolved and in-range by the caller. */
export interface ByteRange {
  offset: number;
  length: number;
}

/**
 * One filesystem change under a watched directory — fsnotify's vocabulary,
 * because that is what the E2B wire speaks. A move fires 'rename' on the
 * old path and 'create' on the new one; 'name' is relative to the watched
 * directory ('sub/x.txt' under a recursive watch).
 */
export interface WatchEvent {
  name: string;
  type: 'create' | 'write' | 'remove' | 'rename' | 'chmod';
}

export interface WatchDirOptions {
  /** Absolute, or relative to /home/user — resolveSandboxPath's rules. */
  path: string;
  /** Watch the whole subtree; directories created later are picked up too. */
  recursive: boolean;
  /** A returned promise is awaited before the next event: backpressure. */
  onEvent: (event: WatchEvent) => void | Promise<void>;
  /**
   * The watcher died without stop() being called — its container stopped,
   * or the watching process failed. Never fires after stop().
   */
  onEnd: (error?: Error) => void;
}

export interface WatchDirHandle {
  /** Stops watching; no events or onEnd are delivered after this resolves. */
  stop(): Promise<void>;
}

/** What the filesystem says about one path — the shape stat and listDir speak. */
export interface SandboxEntry {
  /** Basename; '/' for the root itself. */
  name: string;
  /** Absolute resolved path. */
  path: string;
  /** 'other' covers symlinks, FIFOs and friends — observed, not modeled. */
  type: 'file' | 'dir' | 'other';
  /** Bytes for files; whatever the filesystem reports for directories. */
  sizeBytes: number;
  /** ISO 8601 UTC. */
  modifiedTime: string;
  /** Permission bits, e.g. 0o644. */
  mode: number;
  owner: string;
  group: string;
}

/**
 * A point-in-time resource reading of one sandbox — what the E2B surface's
 * getMetrics reports. Numbers are observations, not promises: a runtime
 * that cannot account for something reports 0, honestly.
 */
export interface SandboxMetrics {
  /** Configured CPU allowance, same source as the control plane's info. */
  cpuCount: number;
  /** Percent of one CPU; can exceed 100 on a multi-CPU sandbox. */
  cpuUsedPct: number;
  memUsedBytes: number;
  memTotalBytes: number;
  memCacheBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
}

/**
 * What every sandbox disk on this host adds up to — the host-level
 * complement to SandboxMetrics' per-sandbox view. Nominal is the summed
 * promised sizes; actual is what the sparse images really occupy. The gap
 * is the disk overcommit, and watching it is the only cap there is.
 */
export interface DiskUsage {
  /** Disk images present, with or without a container — disks are the bodies. */
  count: number;
  nominalBytes: number;
  actualBytes: number;
}

/**
 * The file-op error taxonomy, shared by both executors down to the message
 * (the contract exam holds them to it) and mapped to HTTP statuses by the
 * routes: not found -> 404, not a regular file / not a directory -> 400,
 * too large -> 413, disk full -> 507.
 */
export class FileNotFoundError extends Error {}
export class NotAFileError extends Error {}
export class NotADirectoryError extends Error {}
export class FileTooLargeError extends Error {}
/**
 * The sandbox disk ran out of room mid-write. Only the real executor can
 * produce it (the fake's memory disk has no edge), so unlike the rest of the
 * taxonomy its message is not contract-pinned.
 */
export class DiskFullError extends Error {}

/**
 * What a sandbox's shell is built from. Consulted only at the shell's birth
 * — create(), and start()'s rebuild-from-surviving-disk path; an existing
 * container keeps the image it was born with.
 */
export interface ShellOptions {
  /** Image reference on this host; absent means the executor's configured base image. */
  image?: string;
}

/**
 * The executor is where lifecycle decisions become physical reality:
 * containers created, paused, stopped. The daemon's decision logic (the
 * idle scanner, acquire's wake-ups) only ever talks to this interface, so
 * the Docker+gVisor implementation can land later without touching a line
 * of that logic — and unit tests run against an in-memory fake instead of
 * a container runtime.
 */
export interface Executor {
  /**
   * The image shells boot from when create/start name none. The executor is
   * the one authority on its own default — config knows it only in docker
   * mode, and callers comparing born images against "what would boot next"
   * must not guess.
   */
  readonly baseImage: string;
  /**
   * Brings a brand-new sandbox up to running. `image` picks what the shell
   * boots from (a template's current image); absent means the executor's
   * configured base image.
   */
  create(sandboxId: string, opts?: ShellOptions): Promise<void>;
  /** Running -> paused: stops consuming CPU, memory becomes reclaimable. */
  freeze(sandboxId: string): Promise<void>;
  /** Paused -> running. */
  unfreeze(sandboxId: string): Promise<void>;
  /** Paused -> stopped: the processes die, the disk stays. */
  stop(sandboxId: string): Promise<void>;
  /**
   * Stopped -> running again, from the kept disk. The disk is required; the
   * container object is not — if it was removed behind the daemon's back
   * (a `docker container prune` eats exited containers), a fresh container
   * is rebuilt around the surviving disk. `image` applies only to that
   * rebuild: an image is a property of the shell, fixed at the shell's
   * birth — starting a container that already exists never changes it.
   */
  start(sandboxId: string, opts?: ShellOptions): Promise<void>;
  /**
   * Removes the container and its disk for good, whatever state — or
   * whichever half of the pair — still exists. Throws only when both are
   * already gone: that means the ledger and reality disagree.
   */
  destroy(sandboxId: string): Promise<void>;
  /**
   * Removes the container object, whatever state, and keeps the disk —
   * rebuild's physical half. The next start() builds a fresh container from
   * the surviving disk (and thus from the *current* image of the sandbox's
   * template, or the daemon's current base image); this is how a sandbox
   * upgrades its shared layers without losing data.
   * A container already gone is the goal state as long as the disk remains;
   * both absent throws, like destroy — the ledger and reality disagree.
   */
  removeContainer(sandboxId: string): Promise<void>;
  /**
   * Every container this executor knows about, with its observed state.
   * The reconciler's window into reality — the read the ledger is checked
   * against at startup and on every heartbeat tick.
   */
  listContainers(): Promise<Map<string, ContainerState>>;
  /**
   * Every sandbox id that has a disk on this host, with or without a
   * container. A sandbox's reality is container plus disk; containers can
   * vanish while their disks stay behind (a crash between create's steps,
   * a removal behind the daemon's back), and disks that nothing owns would
   * silently eat the host — so the reconciler observes them too.
   */
  listDisks(): Promise<string[]>;
  /**
   * Removes a sandbox's disk. Reconciliation's cleanup verb, so unlike
   * destroy it is idempotent: an absent disk already is the goal state.
   * Never called while the container exists — destroy tears its own disk.
   */
  removeDisk(sandboxId: string): Promise<void>;
  /**
   * Packs the sandbox's disk into one local archive file at destPath — the
   * archiver's read half. The disk must exist ("disk ... is absent, cannot
   * export") and the container must be stopped or absent ("container ... is
   * <state>, expected stopped or absent"): a live filesystem cannot be
   * captured consistently. The archive's format is each executor's own;
   * only the importDisk round-trip is the contract. Speaks local paths only
   * — object storage is the archiver's business, never the executor's.
   */
  exportDisk(sandboxId: string, destPath: string): Promise<void>;
  /**
   * Provisions a fresh disk — at the executor's *current* configured size,
   * which is how a restored sandbox picks up a raised disk quota — and
   * unpacks an exportDisk archive into it. The disk must not exist yet
   * ("disk ... already exists, cannot import"); a failed unpack tears the
   * fresh disk down again rather than leaving a half-disk behind the verb's
   * own failure. onProgress reports a monotonic fraction 0..1, best-effort,
   * ending at 1.
   */
  importDisk(
    sandboxId: string,
    srcPath: string,
    onProgress?: (fraction: number) => void,
  ): Promise<void>;
  /**
   * Where the host can reach a TCP port of this sandbox — what the sandbox
   * proxy dials to serve `<port>-<sandboxId>.<domain>` traffic. Requires
   * state `running` (same message as every exec verb); whether anything
   * actually listens on the port is discovered at connect time, honestly.
   */
  resolvePortTarget(
    sandboxId: string,
    port: number,
  ): Promise<{ host: string; port: number }>;
  /**
   * A point-in-time resource reading. Unlike the exec verbs it accepts a
   * paused container too — reading cgroup accounting does not require the
   * guest to run, and metrics must never wake a sandbox (observation is
   * not activity, the same principle as listing). A stopped or absent
   * container throws (`expected running or paused`): there is nothing
   * running to measure — the route above answers [] for those on its own.
   */
  metrics(sandboxId: string): Promise<SandboxMetrics>;
  /**
   * The image the sandbox's current shell was born from — an image is a
   * property of the shell, fixed at its birth and gone with it. Returns
   * null when no container object exists (stopped-and-pruned, archived):
   * there is no shell to have an image, and the next start() decides one
   * from the template's current image. A pure read on whatever state the
   * container is in; never wakes anything — observation is not activity.
   */
  imageOf(sandboxId: string): Promise<string | null>;
  /**
   * Every sandbox disk on this host, summed: how many, what they were
   * promised, what they actually occupy. A snapshot like listDisks —
   * a disk torn down mid-scan is simply not counted. Never touches disk
   * contents and never wakes anything: observation is not activity.
   */
  diskUsage(): Promise<DiskUsage>;
  /**
   * Runs a shell command inside a running container and returns the fully
   * buffered result. Requires state `running` — a paused container cannot
   * even receive the exec (measured 2026-07-10: Docker refuses outright).
   * Output is capped at EXEC_OUTPUT_LIMIT_BYTES per stream; the excess is
   * drained and dropped, and the truncation reported.
   */
  exec(sandboxId: string, opts: ExecOptions): Promise<ExecResult>;
  /**
   * Runs a shell command, delivering output live through the callbacks
   * instead of buffering — chunk boundaries follow the command's own writes.
   * The returned promise resolves once the command has started (a start
   * failure rejects here); handle.wait() resolves with the honest exit code.
   * Same running-state requirement and in-container deadline as exec.
   */
  execStream(
    sandboxId: string,
    opts: ExecStreamOptions,
  ): Promise<ExecStreamHandle>;
  /**
   * Writes every file in the batch, in order, failing fast — earlier files
   * stay written (a batch saves round-trips, it is not a transaction).
   * Parent directories are created; existing files are overwritten. Requires
   * state `running`, like exec. Paths resolve inside the container — a
   * symlink planted by the sandbox can only point at the sandbox's own view,
   * never the host's; this is why file I/O goes through the container and
   * not through the host-side mount. No size check here: the protocol
   * schema is the single write-cap adjudicator.
   *
   * Every file verb takes a trailing optional `user` — the identity the
   * in-container operation runs as (ExecOptions.user's rules): ownership of
   * written files and permission outcomes follow it. Absent means 'user'.
   */
  writeFiles(
    sandboxId: string,
    files: FileToWrite[],
    user?: string,
  ): Promise<void>;
  /**
   * Returns one file's bytes. Requires state `running`. Throws the typed
   * file errors above; a file over FILE_SIZE_LIMIT_BYTES is refused, never
   * truncated — a truncated file is a corrupt file. The read cap lives here
   * and not in the schema because only the executor can observe the size.
   */
  readFile(sandboxId: string, path: string, user?: string): Promise<Buffer>;
  /**
   * Streams one file's bytes through the callback, uncapped — nothing
   * accumulates server-side, so the disk quota is the only ceiling (the E2B
   * surface's contract; the native API's 16 MiB cap is the base64-JSON
   * shape's own rule and does not reach here). A returned promise from the
   * callback is awaited before the next chunk: backpressure travels through
   * to the in-container reader. Errors as readFile, minus the size gate.
   *
   * `range` slices the stream to exact bytes — the HTTP Range request's
   * muscle (a video player fetching the mp4's tail-of-file metadata, a
   * seek). The caller resolves the span against the file's stat'd size
   * first; the executor just delivers offset..offset+length.
   */
  readFileStream(
    sandboxId: string,
    path: string,
    onChunk: (chunk: Buffer) => void | Promise<void>,
    user?: string,
    range?: ByteRange,
  ): Promise<void>;
  /**
   * Streams content into one file, uncapped, parents created, overwriting —
   * writeFiles' semantics without materializing the bytes. A full disk
   * throws DiskFullError.
   */
  writeFileStream(
    sandboxId: string,
    path: string,
    content: NodeJS.ReadableStream,
    user?: string,
  ): Promise<void>;
  /**
   * Entries under a directory, depth ≥ 1 levels down, sorted by path.
   * Throws FileNotFoundError for a missing path, NotADirectoryError for a
   * file. Requires state `running`, like every file verb.
   */
  listDir(
    sandboxId: string,
    path: string,
    depth: number,
    user?: string,
  ): Promise<SandboxEntry[]>;
  /** One path's entry. FileNotFoundError when nothing is there. */
  statEntry(
    sandboxId: string,
    path: string,
    user?: string,
  ): Promise<SandboxEntry>;
  /**
   * mkdir -p. True when created; false when the path already exists —
   * whatever it is: claiming "created" over an existing file would be a lie,
   * and the caller's next stat tells the truth either way.
   */
  makeDir(sandboxId: string, path: string, user?: string): Promise<boolean>;
  /**
   * rename(2) semantics (`mv -T`): an existing destination file is
   * replaced, a destination directory is not merged into. The source must
   * exist (FileNotFoundError); parents of the destination are not created.
   * Returns the destination's entry.
   */
  move(
    sandboxId: string,
    from: string,
    to: string,
    user?: string,
  ): Promise<SandboxEntry>;
  /**
   * rm -rf: file or directory tree. FileNotFoundError when nothing is there
   * — removing nothing is a caller's confusion worth reporting, not a goal
   * state (unlike removeDisk, whose caller is reconciliation).
   */
  remove(sandboxId: string, path: string, user?: string): Promise<void>;
  /**
   * Starts watching a directory for filesystem events. The path must exist
   * (FileNotFoundError) and be a directory (NotADirectoryError) — checked
   * before the returned promise resolves; resolution means the watch is
   * established, so a change made right after is seen. Requires state
   * `running`; a freeze suspends the watcher with everything else, and
   * events cannot be missed while frozen — the disk only changes from
   * inside, and anything that reaches inside wakes the sandbox first.
   * Lifetime is bounded by the sandbox's own 24h exec backstop.
   * Deliberately no user option (a v1 narrowing): the watcher runs as
   * 'user', and watching a root-only subtree refuses honestly.
   */
  watchDir(sandboxId: string, opts: WatchDirOptions): Promise<WatchDirHandle>;
}
