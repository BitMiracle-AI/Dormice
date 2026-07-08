/**
 * What a container runtime can observe about a container. Coarser than the
 * ledger's five lifecycle states on purpose: reality knows nothing about
 * `archived` or `restoring` — those live in the ledger and S3.
 */
export type ContainerState = 'running' | 'paused' | 'stopped';

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
  /** Stopped -> running again, from the kept disk. */
  start(sandboxId: string): Promise<void>;
  /** Removes the container and its disk for good, whatever state it is in. */
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
}
