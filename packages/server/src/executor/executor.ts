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
   * The reconciler's window into reality — the one read the ledger is
   * checked against at startup.
   */
  listContainers(): Promise<Map<string, ContainerState>>;
}
