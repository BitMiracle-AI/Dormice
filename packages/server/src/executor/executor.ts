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
}
