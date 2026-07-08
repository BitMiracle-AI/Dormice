import type { ContainerState, Executor } from './executor';

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
  }

  async start(sandboxId: string): Promise<void> {
    this.expect(sandboxId, 'stopped');
    this.containers.set(sandboxId, 'running');
  }

  async destroy(sandboxId: string): Promise<void> {
    // Any state is fine, but the container must exist: destroying something
    // absent means the ledger and reality disagree — a bug worth hearing.
    if (!this.containers.has(sandboxId)) {
      throw new Error(`container ${sandboxId} is absent, cannot destroy`);
    }
    this.containers.delete(sandboxId);
    this.disks.delete(sandboxId);
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
