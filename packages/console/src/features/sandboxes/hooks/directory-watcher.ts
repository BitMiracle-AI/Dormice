import type { EnvdWatchEvent } from '../envd-client';

export interface DirectoryWatcherDeps {
  create(operationId: string): Promise<string>;
  poll(watcherId: string): Promise<EnvdWatchEvent[]>;
  remove(watcherId: string): Promise<void>;
  isActive(): boolean;
  isNotFound(error: unknown): boolean;
  isRetryable(error: unknown): boolean;
  operationId(): string;
  delay(milliseconds: number): Promise<void>;
  onDirty(active: boolean): void;
}

const MAX_CREATE_ATTEMPTS = 3;
const MAX_REMOVE_ATTEMPTS = 3;
const retryDelayMs = (attempt: number) => Math.min(100 * 2 ** attempt, 400);

/**
 * One effect generation's ownership of one polling watcher. Every arm/poll
 * goes through the same single-flight tick; dispose takes the published ID,
 * while an ID still in flight is retired by the create continuation itself.
 *
 * A create generation also owns one operation UUID: ambiguous HTTP outcomes
 * replay with that UUID, so a response lost after server success recovers the
 * same watcher instead of allocating another. Cleanup retries only ambiguous
 * transport/server outcomes and remains private fire-and-forget to React.
 */
export class DirectoryWatcherController {
  private watcherId: string | null = null;
  private operationId: string | null = null;
  private disposed = false;
  private inactiveDirty = false;
  private inFlight: Promise<void> | null = null;
  private releasePromise: Promise<void> | null = null;

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
    if (id) {
      void this.release(id);
      return;
    }
    const operationId = this.operationId;
    this.operationId = null;
    if (operationId && !this.inFlight) {
      void this.recoverAndRelease(operationId);
    }
  }

  private async runTick(): Promise<void> {
    const current = this.watcherId;
    if (current === null) {
      if (!this.deps.isActive()) return;
      const operationId = this.operationId ?? this.deps.operationId();
      this.operationId = operationId;
      let created: string | undefined;
      for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
        try {
          created = await this.deps.create(operationId);
          break;
        } catch (error) {
          if (!this.deps.isRetryable(error)) return;
          if (attempt === MAX_CREATE_ATTEMPTS - 1) {
            if (this.disposed) {
              this.operationId = null;
              void this.recoverAndRelease(operationId);
            }
            return;
          }
          await this.deps.delay(retryDelayMs(attempt));
        }
      }
      if (!created) return;
      this.operationId = null;
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
        this.operationId = null;
      } else if (!this.disposed && this.watcherId === current) {
        // Drain is destructive at the daemon. A lost response may have eaten
        // events, so the directory must converge even though this ID remains.
        this.reportDirty();
      }
    }
  }

  private async recoverAndRelease(operationId: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
      try {
        const watcherId = await this.deps.create(operationId);
        await this.release(watcherId);
        return;
      } catch (error) {
        if (
          !this.deps.isRetryable(error) ||
          attempt === MAX_CREATE_ATTEMPTS - 1
        ) {
          return;
        }
        await this.deps.delay(retryDelayMs(attempt));
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

  private release(watcherId: string): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    const release = this.releaseWithRetry(watcherId).finally(() => {
      if (this.releasePromise === release) this.releasePromise = null;
    });
    this.releasePromise = release;
    return release;
  }

  private async releaseWithRetry(watcherId: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_REMOVE_ATTEMPTS; attempt++) {
      try {
        await this.deps.remove(watcherId);
        return;
      } catch (error) {
        if (
          !this.deps.isRetryable(error) ||
          attempt === MAX_REMOVE_ATTEMPTS - 1
        ) {
          return;
        }
        await this.deps.delay(retryDelayMs(attempt));
      }
    }
  }
}
