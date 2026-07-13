import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { recordActivity } from '../db/activity';
import type { Db } from '../db/db';
import {
  findBySandboxId,
  setPausedByUser,
  touch,
  transition,
} from '../db/ledger';
import type { SandboxRow } from '../db/schema';
import { resolveImage } from '../db/templates';
import type { Executor } from '../executor/executor';
import type { KeyedQueue } from '../keyed-queue';
import { type ArchiveStore, objectKey } from './store';

/** What acquire reports while a sandbox is coming back from the archive. */
export interface RestoreProgress {
  phase: 'downloading' | 'extracting';
  percent: number;
}

interface RestoreEntry {
  /** Mutated in place by the running task; read through progressOf. */
  progress: RestoreProgress;
  /** Settles when the restore finishes — active on success, archived on failure. */
  done: Promise<void>;
}

export interface ArchiverDeps {
  db: Db;
  executor: Executor;
  locks: KeyedQueue;
  store: ArchiveStore;
  /**
   * Where transfer temp files stage. No default on purpose: every
   * construction site chooses, so a unit test can never land in
   * /var/lib/dormice by omission. Production uses <DORMICE_DATA_DIR>/tmp —
   * the same filesystem as the disks (temp archives are disk-sized, and
   * /tmp may be RAM).
   */
  tmpDir: string;
  log?: (msg: string) => void;
}

function clampPercent(fraction: number): number {
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

/**
 * The archive/restore state machine: stopped -> archived (the scanner's
 * move) and archived -> restoring -> active (acquire's). The restore
 * tracker is daemon memory, like the process table — a restart empties it,
 * and the startup reconcile repairs any restoring zombies before listen,
 * so at runtime a restoring row always has a live entry here.
 */
export class Archiver {
  readonly store: ArchiveStore;
  private readonly db: Db;
  private readonly executor: Executor;
  private readonly locks: KeyedQueue;
  private readonly tmpDir: string;
  private readonly log: (msg: string) => void;
  private readonly restores = new Map<string, RestoreEntry>();

  constructor(deps: ArchiverDeps) {
    this.db = deps.db;
    this.executor = deps.executor;
    this.locks = deps.locks;
    this.store = deps.store;
    this.tmpDir = deps.tmpDir;
    this.log = deps.log ?? (() => {});
  }

  /**
   * Boot sweep: everything under tmpDir is a half of some interrupted
   * transfer — the crash-recovery story never depends on temp files, so
   * they are plain garbage here.
   */
  async init(): Promise<void> {
    await rm(this.tmpDir, { recursive: true, force: true });
    await mkdir(this.tmpDir, { recursive: true });
  }

  /**
   * stopped -> archived. The caller holds the key slot and has re-read the
   * row inside it; the state check here guards the destructive tail.
   *
   * The order IS the crash safety: local disk present <=> upload
   * unconfirmed => every crash before the transition simply re-archives on
   * a later sweep (put overwrites the same key). The transition is the
   * confirmation; from there the local copy is cleanup — destroy, not
   * removeDisk, because a stopped row still owns its exited container
   * object, and "local copy freed" includes the shell (the next restore
   * then rebuilds from the template's current image).
   */
  async archive(row: SandboxRow): Promise<void> {
    if (row.state !== 'stopped') {
      throw new Error(
        `sandbox ${row.sandboxId} is ${row.state}, expected stopped — only a stopped sandbox can archive`,
      );
    }
    const startedAt = Date.now();
    const tmp = path.join(this.tmpDir, `${row.sandboxId}.archive.tar.zst`);
    try {
      await this.executor.exportDisk(row.sandboxId, tmp);
      await this.store.put(objectKey(row.sandboxId), tmp);
      transition(this.db, row.sandboxId, 'archived');
      await this.executor.destroy(row.sandboxId);
    } finally {
      await rm(tmp, { force: true });
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    recordActivity(this.db, {
      kind: 'archived',
      externalId: row.externalId,
      sandboxId: row.sandboxId,
      detail: `disk shipped to S3 in ${seconds}s; local copy freed`,
    });
    this.log(`archived ${row.sandboxId} in ${seconds}s`);
  }

  /**
   * archived -> restoring, task fired, returns immediately — acquire's
   * non-blocking half of the protocol's restoring promise. The caller holds
   * the key slot. Calling again while a restore runs joins the same task.
   */
  beginRestore(row: SandboxRow): { progress: RestoreProgress } {
    const existing = this.restores.get(row.sandboxId);
    if (existing) return existing;
    if (row.state !== 'archived') {
      throw new Error(
        `sandbox ${row.sandboxId} is ${row.state}, expected archived — beginRestore is the move on archived rows`,
      );
    }
    transition(this.db, row.sandboxId, 'restoring');
    recordActivity(this.db, {
      kind: 'restore-started',
      externalId: row.externalId,
      sandboxId: row.sandboxId,
      detail: 'restore from S3 began',
    });
    const progress: RestoreProgress = { phase: 'downloading', percent: 0 };
    const done = this.runRestore(
      row.sandboxId,
      row.externalId,
      progress,
    ).finally(() => {
      this.restores.delete(row.sandboxId);
    });
    // Native acquire never awaits this — a failure with no joiner must not
    // crash the daemon as an unhandled rejection. Joiners still observe the
    // rejection through the same promise.
    done.catch(() => {});
    const entry: RestoreEntry = { progress, done };
    this.restores.set(row.sandboxId, entry);
    return entry;
  }

  /** The live progress of a running restore; undefined when none runs. */
  progressOf(sandboxId: string): RestoreProgress | undefined {
    const entry = this.restores.get(sandboxId);
    return entry ? { ...entry.progress } : undefined;
  }

  /** The reconciler's question: is this restoring row a live task or a zombie? */
  hasLiveRestore(sandboxId: string): boolean {
    return this.restores.has(sandboxId);
  }

  /**
   * Blocks until the sandbox is out of the archive — the E2B surface's
   * primitive (that protocol has no restoring concept, so its verbs wait).
   * The key slot is held only to start or find the task; the wait itself
   * happens outside any lock — KeyedQueue is not reentrant, and the task's
   * own finish needs the slot.
   */
  async restoreJoin(sandboxId: string): Promise<void> {
    const row = findBySandboxId(this.db, sandboxId);
    if (!row || (row.state !== 'archived' && row.state !== 'restoring')) {
      return;
    }
    const entry = await this.locks.run(row.externalId, async () => {
      const fresh = findBySandboxId(this.db, sandboxId);
      if (fresh?.state === 'archived') {
        return this.beginRestore(fresh) as RestoreEntry;
      }
      if (fresh?.state === 'restoring') {
        return this.restores.get(sandboxId);
      }
      // Released or already woken while we queued — nothing to join.
      return undefined;
    });
    if (entry) await entry.done;
  }

  /**
   * The restore task. Runs WITHOUT the key lock through the slow middle —
   * the restoring state is the guard (acquire polls answer progress,
   * destroy answers 409, the scanner and reconciler skip) — and takes the
   * slot only for the finish. On failure the half-built disk is removed and
   * the row reverts to archived: the S3 object is untouched, so the next
   * acquire is a clean retry.
   */
  private async runRestore(
    sandboxId: string,
    externalId: string,
    progress: RestoreProgress,
  ): Promise<void> {
    const tmp = path.join(this.tmpDir, `${sandboxId}.restore.tar.zst`);
    try {
      await this.store.get(objectKey(sandboxId), tmp, (fraction) => {
        progress.percent = clampPercent(fraction);
      });
      progress.phase = 'extracting';
      progress.percent = 0;
      await this.executor.importDisk(sandboxId, tmp, (fraction) => {
        progress.percent = clampPercent(fraction);
      });
      await this.locks.run(externalId, async () => {
        const fresh = findBySandboxId(this.db, sandboxId);
        if (fresh?.state !== 'restoring') {
          // Nothing legal moves a restoring row but this task; hearing
          // otherwise is a bug report. The disk just built is task-owned.
          await this.executor.removeDisk(sandboxId);
          throw new Error(
            `sandbox ${sandboxId} became ${fresh?.state ?? 'destroyed'} mid-restore — the restoring state belongs to the restore task alone`,
          );
        }
        await this.executor.start(sandboxId, {
          image: resolveImage(this.db, fresh.template),
        });
        // Awaken semantics, like every wake: an awake sandbox is by
        // definition not paused — without this, an autoPause-archived row
        // would restore into a logically-paused sandbox no one can reach.
        if (fresh.pausedByUser) {
          setPausedByUser(this.db, sandboxId, false);
        }
        transition(this.db, sandboxId, 'active');
        touch(this.db, sandboxId);
        recordActivity(this.db, {
          kind: 'restored',
          externalId,
          sandboxId,
          detail: 'disk back from S3, sandbox active; archive object deleted',
        });
      });
      // The object's job is done — the disk is local again, so from here
      // "an object exists" means "the row is archived", and destroy never
      // has to chase stale copies. Best effort: a leaked object costs
      // pennies, failing a finished restore over cleanup costs a wake.
      await this.store.delete(objectKey(sandboxId)).catch(() => {});
    } catch (err) {
      this.log(
        `restore of ${sandboxId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.executor.removeDisk(sandboxId).catch(() => {});
      await this.locks.run(externalId, async () => {
        const fresh = findBySandboxId(this.db, sandboxId);
        if (fresh?.state === 'restoring') {
          transition(this.db, sandboxId, 'archived');
          recordActivity(this.db, {
            kind: 'restore-failed',
            externalId,
            sandboxId,
            detail: `back to archived, S3 object intact — ${
              err instanceof Error ? err.message : String(err)
            }`.slice(0, 300),
          });
        }
      });
      throw err;
    } finally {
      await rm(tmp, { force: true });
    }
  }
}
