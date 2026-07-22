import { randomUUID } from 'node:crypto';
import type {
  Executor,
  WatchDirHandle,
  WatchEvent,
} from '../executor/executor';

/**
 * The polling half of directory watching — what the sync SDKs use instead
 * of the WatchDir stream: CreateWatcher parks a watcher here, GetWatcherEvents
 * drains its buffer, RemoveWatcher retires it. Daemon memory, like the process
 * table: a daemon restart empties it honestly, and a watcher's death (its
 * container stopping) deletes its record through physical conduction — the
 * next poll answers not_found, no lifecycle hooks involved.
 *
 * Two ceilings real envd does not have, on purpose: envd runs inside the
 * sandbox, so its unbounded buffer can only blow up the sandbox itself —
 * this table lives in the host-side daemon, where unbounded means one
 * sandbox writing files in a loop grows the host's memory. The buffer keeps
 * the newest events (oldest dropped first); the per-sandbox watcher count
 * refuses with resource_exhausted. Starting and retired records count too:
 * reservations make the ceiling true under concurrent creates, and retired
 * handles still own a physical process until the next legitimate wake reaps it.
 */
export const MAX_EVENTS_PER_WATCHER = 8192;
export const MAX_WATCHERS_PER_SANDBOX = 128;

/** Refused watcher creation: the per-sandbox ceiling. */
export class WatcherLimitError extends Error {}

interface WatcherRecord {
  watcherId: string;
  sandboxId: string;
  events: WatchEvent[];
  state: 'starting' | 'active' | 'retired' | 'ended';
  handle?: WatchDirHandle;
  endError?: Error;
  stopPromise?: Promise<void>;
}

export class WatcherTable {
  private readonly records = new Map<string, WatcherRecord>();

  /** Starts a watcher, reserving capacity before the executor can yield. */
  async create(args: {
    executor: Executor;
    sandboxId: string;
    path: string;
    recursive: boolean;
  }): Promise<string> {
    const { executor, sandboxId, path, recursive } = args;
    if (this.count(sandboxId) >= MAX_WATCHERS_PER_SANDBOX) {
      throw new WatcherLimitError(
        `sandbox ${sandboxId} already has ${MAX_WATCHERS_PER_SANDBOX} watchers — remove some before creating more`,
      );
    }

    const record: WatcherRecord = {
      watcherId: randomUUID(),
      sandboxId,
      events: [],
      state: 'starting',
    };
    this.records.set(record.watcherId, record);

    try {
      const handle = await executor.watchDir(sandboxId, {
        path,
        recursive,
        onEvent: (event) => {
          if (record.state !== 'starting' && record.state !== 'active') return;
          record.events.push(event);
          if (record.events.length > MAX_EVENTS_PER_WATCHER) {
            record.events.shift();
          }
        },
        onEnd: (error) => {
          record.endError = error;
          this.finalize(record);
        },
      });
      record.handle = handle;
      if (record.state !== 'starting') {
        const failure =
          record.endError ?? new Error('watcher retired while starting');
        record.state = 'retired';
        await this.stopRetired(record);
        throw failure;
      }
      record.state = 'active';
      return record.watcherId;
    } catch (error) {
      this.finalize(record);
      throw error;
    }
  }

  /** Living, published watcher events; retired/starting IDs read as absent. */
  drain(sandboxId: string, watcherId: string): WatchEvent[] | undefined {
    const record = this.records.get(watcherId);
    if (
      !record ||
      record.sandboxId !== sandboxId ||
      record.state !== 'active'
    ) {
      return undefined;
    }
    return record.events.splice(0, record.events.length);
  }

  /**
   * Retires without touching the container. Frozen cleanup stays cold; the
   * next real wake calls reapRetired before serving user work.
   */
  retire(sandboxId: string, watcherId: string): boolean {
    const record = this.records.get(watcherId);
    if (!record || record.sandboxId !== sandboxId) return false;
    record.state = 'retired';
    record.events.length = 0;
    return true;
  }

  /** Stops now. A failed stop remains retired so the next wake can retry. */
  async remove(sandboxId: string, watcherId: string): Promise<boolean> {
    const record = this.records.get(watcherId);
    if (!record || record.sandboxId !== sandboxId) return false;
    record.state = 'retired';
    record.events.length = 0;
    await this.stopRetired(record);
    return true;
  }

  /** Reaps deferred frozen cleanup after a legitimate wake made it runnable. */
  async reapRetired(sandboxId: string): Promise<void> {
    const retired = [...this.records.values()].filter(
      (record) => record.sandboxId === sandboxId && record.state === 'retired',
    );
    for (const record of retired) {
      try {
        await this.stopRetired(record);
      } catch {
        // Cleanup is subordinate to the user work that caused this wake.
        // The record stays retired and the next legitimate wake retries it.
      }
    }
  }

  count(sandboxId: string): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.sandboxId === sandboxId && record.state !== 'ended') count++;
    }
    return count;
  }

  private async stopRetired(record: WatcherRecord): Promise<void> {
    if (record.state === 'ended') return;
    const handle = record.handle;
    if (!handle) return;
    if (!record.stopPromise) {
      record.stopPromise = handle.stop().then(
        () => this.finalize(record),
        (error) => {
          record.stopPromise = undefined;
          throw error;
        },
      );
    }
    await record.stopPromise;
  }

  private finalize(record: WatcherRecord): void {
    if (record.state === 'ended') return;
    record.state = 'ended';
    this.records.delete(record.watcherId);
    record.events.length = 0;
  }
}
