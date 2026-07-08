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
}
