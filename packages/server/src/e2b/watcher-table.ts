import { randomUUID } from 'node:crypto';
import { resolveSandboxPath } from '@dormice/shared';
import type {
  Executor,
  WatchDirHandle,
  WatchEvent,
} from '../executor/executor';

/**
 * The daemon-owned half of directory watching. Polling watchers publish an ID
 * whose event buffer can be drained; streaming watchers attach their delivery
 * callback directly. Both kinds park their physical handle here so request
 * teardown, natural process exit, sandbox lifecycle, and daemon shutdown all
 * converge through one owner.
 *
 * Two ceilings real envd does not have, on purpose: envd runs inside the
 * sandbox, so its unbounded state can only blow up the sandbox itself — this
 * registry lives in the host-side daemon. Starting and retired records count
 * too: reservations make the watcher ceiling true under concurrent starts,
 * and retired handles still own a physical process until a legitimate wake
 * reaps them.
 */
export const MAX_EVENTS_PER_WATCHER = 8192;
export const MAX_WATCHERS_PER_SANDBOX = 128;

/** Five minutes comfortably covers a bounded client retry sequence. */
export const WATCHER_OPERATION_RETENTION_MS = 5 * 60 * 1000;
/** Live bindings plus completed tombstones; live bindings are never evicted. */
export const MAX_WATCHER_OPERATIONS_PER_SANDBOX = 256;

/** Refused watcher creation: the per-sandbox physical watcher ceiling. */
export class WatcherLimitError extends Error {}
/** Refused opt-in create: its bounded operation ledger is full. */
export class WatcherOperationLimitError extends Error {}
/** The same operation identity was reused for a different canonical request. */
export class WatcherOperationConflictError extends Error {}

interface OperationIdentity {
  id: string;
  fingerprint: string;
}

interface WatcherRecord {
  watcherId: string;
  sandboxId: string;
  kind: 'polling' | 'streaming';
  events: WatchEvent[];
  state: 'starting' | 'active' | 'retired' | 'ended';
  operation?: OperationIdentity;
  published: boolean;
  handle?: WatchDirHandle;
  endError?: Error;
  startPromise?: Promise<string>;
  stopPromise?: Promise<void>;
  streamEnd?: (error?: Error) => void;
  streamEndNotified?: boolean;
}

interface OperationTombstone extends OperationIdentity {
  kind: 'tombstone';
  sandboxId: string;
  watcherId: string;
  expiresAt: number;
}

type OperationEntry =
  | { kind: 'live'; record: WatcherRecord }
  | OperationTombstone;

export interface WatcherTableOptions {
  now?: () => number;
  operationRetentionMs?: number;
  maxOperationsPerSandbox?: number;
  retryDelay?: (milliseconds: number) => Promise<void>;
}

interface CreateArgs {
  executor: Executor;
  sandboxId: string;
  path: string;
  recursive: boolean;
  operationId?: string;
}

interface CreateStreamingArgs extends Omit<CreateArgs, 'operationId'> {
  reservationId?: string;
  onEvent: (event: WatchEvent) => void | Promise<void>;
  onEnd(error?: Error): void;
}

export class WatcherTable {
  private readonly records = new Map<string, WatcherRecord>();
  private readonly operations = new Map<string, OperationEntry>();
  private readonly now: () => number;
  private readonly operationRetentionMs: number;
  private readonly maxOperationsPerSandbox: number;
  private readonly retryDelay: (milliseconds: number) => Promise<void>;
  private closed = false;

  constructor(opts: WatcherTableOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.operationRetentionMs =
      opts.operationRetentionMs ?? WATCHER_OPERATION_RETENTION_MS;
    this.maxOperationsPerSandbox =
      opts.maxOperationsPerSandbox ?? MAX_WATCHER_OPERATIONS_PER_SANDBOX;
    this.retryDelay =
      opts.retryDelay ??
      ((milliseconds) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  }

  /**
   * Starts a polling watcher. An optional Dormice operation ID makes the
   * result replay-safe without changing official envd's protobuf message.
   */
  async create(args: CreateArgs): Promise<string> {
    this.pruneOperations();
    const operation = args.operationId
      ? {
          id: args.operationId,
          fingerprint: this.fingerprint(args.path, args.recursive),
        }
      : undefined;

    if (operation) {
      const existing = this.operations.get(
        this.operationKey(args.sandboxId, operation.id),
      );
      if (existing) return this.replay(existing, operation);
      if (this.operationCount(args.sandboxId) >= this.maxOperationsPerSandbox) {
        throw new WatcherOperationLimitError(
          `sandbox ${args.sandboxId} already has ${this.maxOperationsPerSandbox} retained watcher operations — retry after the replay window expires`,
        );
      }
    }

    const record = this.reserve(args.sandboxId, 'polling', operation);
    const started = this.start(record, args, (event) => {
      if (record.state !== 'starting' && record.state !== 'active') return;
      record.events.push(event);
      if (record.events.length > MAX_EVENTS_PER_WATCHER) {
        record.events.shift();
      }
    });
    record.startPromise = started;
    return started;
  }

  /** Reserves one registry slot for a streaming watcher before physical start. */
  reserveStreaming(sandboxId: string): string {
    return this.reserve(sandboxId, 'streaming').watcherId;
  }

  /** Releases an unpublished streaming reservation after wake/start refusal. */
  cancelStreamingReservation(sandboxId: string, watcherId: string): void {
    const record = this.records.get(watcherId);
    if (
      record?.sandboxId === sandboxId &&
      record.kind === 'streaming' &&
      record.state === 'starting' &&
      !record.published
    ) {
      this.finalize(record);
    }
  }

  /** Starts a streaming watcher under the same capacity and cleanup owner. */
  async createStreaming(args: CreateStreamingArgs): Promise<string> {
    const reserved = args.reservationId
      ? this.records.get(args.reservationId)
      : undefined;
    if (
      args.reservationId &&
      (!reserved ||
        reserved.sandboxId !== args.sandboxId ||
        reserved.kind !== 'streaming' ||
        reserved.state !== 'starting')
    ) {
      throw new Error(
        `streaming watcher reservation ${args.reservationId} is not live`,
      );
    }
    const record = reserved ?? this.reserve(args.sandboxId, 'streaming');
    record.streamEnd = args.onEnd;
    const started = this.start(record, args, async (event) => {
      if (record.state !== 'starting' && record.state !== 'active') return;
      await args.onEvent(event);
    });
    record.startPromise = started;
    return started;
  }

  /** Living, published polling events; every other ID reads as absent. */
  drain(sandboxId: string, watcherId: string): WatchEvent[] | undefined {
    const record = this.records.get(watcherId);
    if (
      !record ||
      record.sandboxId !== sandboxId ||
      record.kind !== 'polling' ||
      record.state !== 'active'
    ) {
      return undefined;
    }
    return record.events.splice(0, record.events.length);
  }

  /**
   * Makes one well-formed watcher ID absent from this sandbox. Unknown and
   * cross-sandbox IDs already satisfy that goal and deliberately look alike.
   * A cold sandbox retires without touching its container.
   */
  async removeGoal(
    sandboxId: string,
    watcherId: string,
    opts: { runnable: boolean; attempts?: number } = { runnable: true },
  ): Promise<void> {
    const record = this.records.get(watcherId);
    if (!record || record.sandboxId !== sandboxId) return;
    record.state = 'retired';
    record.events.length = 0;
    if (!opts.runnable) return;

    const attempts = Math.max(1, opts.attempts ?? 1);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.stopRetired(record);
        return;
      } catch (error) {
        if (attempt === attempts || !this.records.has(record.watcherId)) {
          throw error;
        }
        await this.retryDelay(Math.min(25 * 2 ** (attempt - 1), 100));
      }
    }
  }

  /** Backward-compatible spelling for existing callers and focused tests. */
  async remove(sandboxId: string, watcherId: string): Promise<boolean> {
    const record = this.records.get(watcherId);
    if (!record || record.sandboxId !== sandboxId) return false;
    await this.removeGoal(sandboxId, watcherId, { runnable: true });
    return true;
  }

  /** Retires without touching the container; a legitimate wake reaps it. */
  retire(sandboxId: string, watcherId: string): boolean {
    const record = this.records.get(watcherId);
    if (!record || record.sandboxId !== sandboxId) return false;
    record.state = 'retired';
    record.events.length = 0;
    return true;
  }

  /** Reaps all deferred polling and streaming cleanup after a legitimate wake. */
  async reapDeferred(sandboxId: string): Promise<void> {
    const retired = [...this.records.values()].filter(
      (record) => record.sandboxId === sandboxId && record.state === 'retired',
    );
    for (const record of retired) {
      try {
        await this.stopRetired(record);
      } catch {
        // Cleanup is subordinate to the user work that caused this wake. The
        // record stays retired and the next legitimate wake retries it.
      }
    }
  }

  /** Backward-compatible name while lifecycle call sites migrate. */
  reapRetired(sandboxId: string): Promise<void> {
    return this.reapDeferred(sandboxId);
  }

  /** A proven container stop/destroy ends every watcher without signaling it. */
  disposeSandbox(sandboxId: string): void {
    for (const record of [...this.records.values()]) {
      if (record.sandboxId !== sandboxId) continue;
      this.notifyStreamEnd(record, new Error('sandbox container ended'));
      this.finalize(record, false);
    }
  }

  /** Stops a route-owned streaming watcher while retaining failed cleanup. */
  closeStreaming(
    sandboxId: string,
    watcherId: string,
    opts: { runnable: boolean },
  ): Promise<void> {
    return this.removeGoal(sandboxId, watcherId, {
      runnable: opts.runnable,
      attempts: opts.runnable ? 3 : 1,
    });
  }

  /** Bounded best-effort teardown for Fastify/daemon shutdown. */
  async shutdown(timeoutMs = 5000): Promise<void> {
    this.closed = true;
    const records = [...this.records.values()];
    for (const record of records) {
      record.state = 'retired';
      record.events.length = 0;
      this.notifyStreamEnd(record);
    }
    const stopping = Promise.allSettled(
      records.map((record) => this.stopRetired(record)),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      stopping,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    for (const record of records) this.finalize(record);
  }

  count(sandboxId: string): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.sandboxId === sandboxId && record.state !== 'ended') count++;
    }
    return count;
  }

  operationCount(sandboxId: string): number {
    this.pruneOperations();
    let count = 0;
    for (const entry of this.operations.values()) {
      const owner =
        entry.kind === 'live' ? entry.record.sandboxId : entry.sandboxId;
      if (owner === sandboxId) count++;
    }
    return count;
  }

  private reserve(
    sandboxId: string,
    kind: WatcherRecord['kind'],
    operation?: OperationIdentity,
  ): WatcherRecord {
    if (this.closed) throw new Error('watcher registry is shutting down');
    if (this.count(sandboxId) >= MAX_WATCHERS_PER_SANDBOX) {
      throw new WatcherLimitError(
        `sandbox ${sandboxId} already has ${MAX_WATCHERS_PER_SANDBOX} watchers — remove some before creating more`,
      );
    }
    const record: WatcherRecord = {
      watcherId: randomUUID(),
      sandboxId,
      kind,
      events: [],
      state: 'starting',
      operation,
      published: false,
    };
    this.records.set(record.watcherId, record);
    if (operation) {
      this.operations.set(this.operationKey(sandboxId, operation.id), {
        kind: 'live',
        record,
      });
    }
    return record;
  }

  private async start(
    record: WatcherRecord,
    args: Omit<CreateArgs, 'operationId'>,
    onEvent: (event: WatchEvent) => void | Promise<void>,
  ): Promise<string> {
    try {
      const handle = await args.executor.watchDir(args.sandboxId, {
        path: resolveSandboxPath(args.path),
        recursive: args.recursive,
        onEvent,
        onEnd: (error) => {
          record.endError = error;
          const published = record.published;
          if (published) this.notifyStreamEnd(record, error);
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
      record.published = true;
      return record.watcherId;
    } catch (error) {
      this.finalize(record);
      throw error;
    }
  }

  private replay(
    existing: OperationEntry,
    operation: OperationIdentity,
  ): Promise<string> {
    const fingerprint =
      existing.kind === 'live'
        ? existing.record.operation?.fingerprint
        : existing.fingerprint;
    if (fingerprint !== operation.fingerprint) {
      throw new WatcherOperationConflictError(
        `watcher operation ${operation.id} was already used with different path or options`,
      );
    }
    if (existing.kind === 'tombstone') {
      return Promise.resolve(existing.watcherId);
    }
    return (
      existing.record.startPromise ?? Promise.resolve(existing.record.watcherId)
    );
  }

  private async stopRetired(record: WatcherRecord): Promise<void> {
    if (record.state === 'ended') return;
    const handle = record.handle;
    if (!handle) return;
    if (!record.stopPromise) {
      const attempt = handle.stop().then(
        () => this.finalize(record),
        (error) => {
          if (record.stopPromise === attempt) record.stopPromise = undefined;
          throw error;
        },
      );
      record.stopPromise = attempt;
    }
    await record.stopPromise;
  }

  private notifyStreamEnd(record: WatcherRecord, error?: Error): void {
    if (record.kind !== 'streaming' || record.streamEndNotified) return;
    record.streamEndNotified = true;
    record.streamEnd?.(error);
  }

  private finalize(record: WatcherRecord, retainOperation = true): void {
    if (record.state === 'ended') return;
    record.state = 'ended';
    this.records.delete(record.watcherId);
    record.events.length = 0;
    if (!record.operation) return;

    const key = this.operationKey(record.sandboxId, record.operation.id);
    const entry = this.operations.get(key);
    if (entry?.kind !== 'live' || entry.record !== record) return;
    if (!record.published || !retainOperation) {
      this.operations.delete(key);
      return;
    }
    this.operations.set(key, {
      kind: 'tombstone',
      sandboxId: record.sandboxId,
      watcherId: record.watcherId,
      ...record.operation,
      expiresAt: this.now() + this.operationRetentionMs,
    });
  }

  private pruneOperations(): void {
    const now = this.now();
    for (const [key, entry] of this.operations) {
      if (entry.kind === 'tombstone' && entry.expiresAt <= now) {
        this.operations.delete(key);
      }
    }
  }

  private fingerprint(path: string, recursive: boolean): string {
    return JSON.stringify([resolveSandboxPath(path), recursive]);
  }

  private operationKey(sandboxId: string, operationId: string): string {
    return `${sandboxId}\0${operationId}`;
  }
}
