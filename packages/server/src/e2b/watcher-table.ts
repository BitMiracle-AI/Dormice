import { randomUUID } from 'node:crypto';
import type {
  Executor,
  WatchDirHandle,
  WatchEvent,
} from '../executor/executor';

/**
 * The polling half of directory watching — what the sync SDKs use instead
 * of the WatchDir stream: CreateWatcher parks a watcher here, GetWatcherEvents
 * drains its buffer, RemoveWatcher stops it. Daemon memory, like the process
 * table: a daemon restart empties it honestly, and a watcher's death (its
 * container stopping) deletes its record through physical conduction — the
 * next poll answers not_found, no lifecycle hooks involved.
 *
 * Two ceilings real envd does not have, on purpose: envd runs inside the
 * sandbox, so its unbounded buffer can only blow up the sandbox itself —
 * this table lives in the host-side daemon, where unbounded means one
 * sandbox writing files in a loop grows the host's memory. The buffer keeps
 * the newest events (oldest dropped first); the per-sandbox watcher count
 * refuses with resource_exhausted.
 */
export const MAX_EVENTS_PER_WATCHER = 8192;
export const MAX_WATCHERS_PER_SANDBOX = 128;

/** Refused watcher creation: the per-sandbox ceiling. */
export class WatcherLimitError extends Error {}

interface WatcherRecord {
  watcherId: string;
  sandboxId: string;
  events: WatchEvent[];
  handle: WatchDirHandle;
}

export class WatcherTable {
  private readonly records = new Map<string, WatcherRecord>();

  /**
   * Starts a watcher and parks it. Path errors (missing, not a directory)
   * surface as the executor's typed errors, exactly like the streaming face.
   */
  async create(args: {
    executor: Executor;
    sandboxId: string;
    path: string;
    recursive: boolean;
  }): Promise<string> {
    const { executor, sandboxId, path, recursive } = args;
    let count = 0;
    for (const record of this.records.values()) {
      if (record.sandboxId === sandboxId) count++;
    }
    if (count >= MAX_WATCHERS_PER_SANDBOX) {
      throw new WatcherLimitError(
        `sandbox ${sandboxId} already has ${MAX_WATCHERS_PER_SANDBOX} watchers — remove some before creating more`,
      );
    }
    const watcherId = randomUUID();
    const events: WatchEvent[] = [];
    const handle = await executor.watchDir(sandboxId, {
      path,
      recursive,
      onEvent: (event) => {
        events.push(event);
        if (events.length > MAX_EVENTS_PER_WATCHER) events.shift();
      },
      // The watcher died with its container: the record goes with it, so
      // the next poll answers not_found — the closest honest translation
      // of "the envd you were polling is gone".
      onEnd: () => {
        this.records.delete(watcherId);
      },
    });
    this.records.set(watcherId, { watcherId, sandboxId, events, handle });
    return watcherId;
  }

  /**
   * Drains and returns the buffered events — real envd's read-and-reset.
   * undefined when the watcher does not exist for this sandbox; ids are
   * sandbox-scoped like pids, so one sandbox cannot poll another's watcher.
   */
  drain(sandboxId: string, watcherId: string): WatchEvent[] | undefined {
    const record = this.records.get(watcherId);
    if (!record || record.sandboxId !== sandboxId) return undefined;
    return record.events.splice(0, record.events.length);
  }

  /** Stops and forgets a watcher. False when there is nothing to remove. */
  async remove(sandboxId: string, watcherId: string): Promise<boolean> {
    const record = this.records.get(watcherId);
    if (!record || record.sandboxId !== sandboxId) return false;
    this.records.delete(watcherId);
    await record.handle.stop();
    return true;
  }
}
