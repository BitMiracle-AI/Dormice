import type { EnvdWatchEvent } from '../envd-client';

export interface DirectoryWatcherDeps {
  create(): Promise<string>;
  poll(watcherId: string): Promise<EnvdWatchEvent[]>;
  remove(watcherId: string): Promise<void>;
  isActive(): boolean;
  isNotFound(error: unknown): boolean;
  onDirty(active: boolean): void;
}

/**
 * One effect generation's ownership of one polling watcher. Every arm/poll
 * goes through the same single-flight tick; dispose takes the published ID,
 * while an ID still in flight is retired by the create continuation itself.
 */
export class DirectoryWatcherController {
  private watcherId: string | null = null;
  private disposed = false;
  private inactiveDirty = false;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: DirectoryWatcherDeps) {}

  tick(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.deps.isActive() && this.inactiveDirty) {
      this.inactiveDirty = false;
      this.deps.onDirty(true);
    }
    if (this.inFlight) return this.inFlight;

    const run = this.runTick();
    this.inFlight = run;
    void run.finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    return run;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const id = this.takeWatcher();
    if (id) void this.release(id);
  }

  private async runTick(): Promise<void> {
    const current = this.watcherId;
    if (current === null) {
      if (!this.deps.isActive()) return;
      let created: string;
      try {
        created = await this.deps.create();
      } catch {
        return;
      }
      if (this.disposed) {
        await this.release(created);
        return;
      }
      this.watcherId = created;
      return;
    }

    try {
      const events = await this.deps.poll(current);
      if (!this.disposed && this.watcherId === current && events.length > 0) {
        this.reportDirty();
      }
    } catch (error) {
      if (this.deps.isNotFound(error) && this.watcherId === current) {
        this.watcherId = null;
      } else if (!this.disposed && this.watcherId === current) {
        // Drain is destructive at the daemon. A lost response may have eaten
        // events, so the directory must converge even though this ID remains.
        this.reportDirty();
      }
    }
  }

  private reportDirty(): void {
    const active = this.deps.isActive();
    if (!active) this.inactiveDirty = true;
    this.deps.onDirty(active);
  }

  private takeWatcher(): string | null {
    const id = this.watcherId;
    this.watcherId = null;
    return id;
  }

  private async release(watcherId: string): Promise<void> {
    try {
      await this.deps.remove(watcherId);
    } catch {
      // Gone already is the cleanup goal; lifecycle races are expected here.
    }
  }
}
