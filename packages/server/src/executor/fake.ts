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

  /** Test hook: what does "reality" say about this sandbox? */
  stateOf(sandboxId: string): ContainerState | undefined {
    return this.containers.get(sandboxId);
  }

  async create(sandboxId: string): Promise<void> {
    if (this.containers.has(sandboxId)) {
      throw new Error(`container ${sandboxId} already exists`);
    }
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
  }

  async listContainers(): Promise<Map<string, ContainerState>> {
    // A copy: reality is observed, not handed out by reference.
    return new Map(this.containers);
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
