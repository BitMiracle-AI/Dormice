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
  /** A shell string, executed as `bash -c <command>` inside the sandbox. */
  command: string;
  /** Same in-container deadline as ExecOptions; on expiry exit 137. */
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
   * verbs then refuse honestly instead of writing into nothing.
   */
  stdin?: boolean;
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
 * The executor is where lifecycle decisions become physical reality:
 * containers created, paused, stopped. The daemon's decision logic (the
 * idle scanner, acquire's wake-ups) only ever talks to this interface, so
 * the Docker+gVisor implementation can land later without touching a line
 * of that logic — and unit tests run against an in-memory fake instead of
 * a container runtime.
 */
export interface Executor {
  /** Brings a brand-new sandbox up to running. */
  create(sandboxId: string): Promise<void>;
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
   * is rebuilt around the surviving disk.
   */
  start(sandboxId: string): Promise<void>;
  /**
   * Removes the container and its disk for good, whatever state — or
   * whichever half of the pair — still exists. Throws only when both are
   * already gone: that means the ledger and reality disagree.
   */
  destroy(sandboxId: string): Promise<void>;
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
   */
  writeFiles(sandboxId: string, files: FileToWrite[]): Promise<void>;
  /**
   * Returns one file's bytes. Requires state `running`. Throws the typed
   * file errors above; a file over FILE_SIZE_LIMIT_BYTES is refused, never
   * truncated — a truncated file is a corrupt file. The read cap lives here
   * and not in the schema because only the executor can observe the size.
   */
  readFile(sandboxId: string, path: string): Promise<Buffer>;
  /**
   * Streams one file's bytes through the callback, uncapped — nothing
   * accumulates server-side, so the disk quota is the only ceiling (the E2B
   * surface's contract; the native API's 16 MiB cap is the base64-JSON
   * shape's own rule and does not reach here). A returned promise from the
   * callback is awaited before the next chunk: backpressure travels through
   * to the in-container reader. Errors as readFile, minus the size gate.
   */
  readFileStream(
    sandboxId: string,
    path: string,
    onChunk: (chunk: Buffer) => void | Promise<void>,
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
  ): Promise<SandboxEntry[]>;
  /** One path's entry. FileNotFoundError when nothing is there. */
  statEntry(sandboxId: string, path: string): Promise<SandboxEntry>;
  /**
   * mkdir -p. True when created; false when the path already exists —
   * whatever it is: claiming "created" over an existing file would be a lie,
   * and the caller's next stat tells the truth either way.
   */
  makeDir(sandboxId: string, path: string): Promise<boolean>;
  /**
   * rename(2) semantics (`mv -T`): an existing destination file is
   * replaced, a destination directory is not merged into. The source must
   * exist (FileNotFoundError); parents of the destination are not created.
   * Returns the destination's entry.
   */
  move(sandboxId: string, from: string, to: string): Promise<SandboxEntry>;
  /**
   * rm -rf: file or directory tree. FileNotFoundError when nothing is there
   * — removing nothing is a caller's confusion worth reporting, not a goal
   * state (unlike removeDisk, whose caller is reconciliation).
   */
  remove(sandboxId: string, path: string): Promise<void>;
}
