import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIFECYCLE_POLICY } from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import { type Db, migrateDb, openDb } from '../db/db';
import { createSandbox, findByName, transition } from '../db/ledger';
import type { SandboxRow } from '../db/schema';
import { FakeExecutor } from '../executor/fake';
import { KeyedQueue } from '../keyed-queue';
import { Archiver } from './archiver';
import { MemStore } from './mem-store';
import { objectKey } from './store';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

function setup() {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const executor = new FakeExecutor();
  const locks = new KeyedQueue();
  const store = new MemStore();
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'dormice-archiver-'));
  const archiver = new Archiver({ db, executor, locks, store, tmpDir });
  return { db, executor, locks, store, tmpDir, archiver };
}

/** A stopped sandbox with a marker file — the archiver's raw material. */
async function seedStopped(
  db: Db,
  executor: FakeExecutor,
  name: string,
): Promise<SandboxRow> {
  const id = randomUUID();
  await executor.create(id);
  await executor.writeFiles(id, [
    { path: 'kept.txt', content: Buffer.from(`data of ${name}`) },
  ]);
  createSandbox(db, {
    id,
    name,
    nodeId: 'node-test',
    policy: DEFAULT_LIFECYCLE_POLICY,
  });
  await executor.freeze(id);
  await executor.stop(id);
  transition(db, id, 'frozen');
  return transition(db, id, 'stopped');
}

describe('Archiver.archive', () => {
  it('uploads, records archived, and frees the local copy', async () => {
    const { db, executor, store, tmpDir, archiver } = setup();
    const row = await seedStopped(db, executor, 'alice');

    await archiver.archive(row);

    expect(store.has(objectKey(row.id))).toBe(true);
    expect(findByName(db, 'alice')?.state).toBe('archived');
    // "Local copy freed" includes the shell: destroy, not just the disk.
    expect(executor.stateOf(row.id)).toBeUndefined();
    expect(await executor.listDisks()).not.toContain(row.id);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('uploads before recording, records before destroying', async () => {
    // The order IS the crash safety: flip any two steps and some crash
    // window loses data (upload after transition -> a crash strands an
    // archived row with no object; destroy before transition -> the
    // reconciler deletes the "stopped" row whose reality vanished). Each
    // observed step records the ledger state at its own moment, so the
    // transition is pinned BETWEEN them, not merely somewhere.
    const { db, tmpDir } = setup();
    const events: string[] = [];
    const watchingStore = new (class extends MemStore {
      override async put(key: string, filePath: string): Promise<void> {
        events.push(`put while ${findByName(db, 'alice')?.state}`);
        await super.put(key, filePath);
      }
    })();
    const watchingExecutor = new (class extends FakeExecutor {
      override async destroy(sandboxId: string): Promise<void> {
        events.push(`destroy while ${findByName(db, 'alice')?.state}`);
        await super.destroy(sandboxId);
      }
    })();
    const archiver = new Archiver({
      db,
      executor: watchingExecutor,
      locks: new KeyedQueue(),
      store: watchingStore,
      tmpDir,
    });
    const row = await seedStopped(db, watchingExecutor, 'alice');

    await archiver.archive(row);

    expect(events).toEqual(['put while stopped', 'destroy while archived']);
  });

  it('a failed upload leaves a retryable stopped sandbox', async () => {
    const { db, executor, tmpDir } = setup();
    const failingStore = new (class extends MemStore {
      override async put(): Promise<void> {
        throw new Error('the bucket said no');
      }
    })();
    const archiver = new Archiver({
      db,
      executor,
      locks: new KeyedQueue(),
      store: failingStore,
      tmpDir,
    });
    const row = await seedStopped(db, executor, 'alice');

    await expect(archiver.archive(row)).rejects.toThrow('the bucket said no');
    // The invariant as behavior: disk still present <=> upload unconfirmed,
    // so the row stays stopped and the next sweep retries the whole thing.
    expect(findByName(db, 'alice')?.state).toBe('stopped');
    expect(await executor.listDisks()).toContain(row.id);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('refuses a row that is not stopped', async () => {
    const { db, executor, archiver } = setup();
    const id = randomUUID();
    await executor.create(id);
    const row = createSandbox(db, {
      id,
      name: 'alice',
      nodeId: 'node-test',
      policy: DEFAULT_LIFECYCLE_POLICY,
    });
    await expect(archiver.archive(row)).rejects.toThrow(
      `sandbox ${id} is active, expected stopped`,
    );
  });
});

describe('Archiver.beginRestore', () => {
  it('flips to restoring at once and lands active with the data back', async () => {
    const { db, executor, store, tmpDir, archiver } = setup();
    const row = await seedStopped(db, executor, 'alice');
    await archiver.archive(row);
    const archived = findByName(db, 'alice');
    if (!archived) throw new Error('row vanished');

    let entry: ReturnType<Archiver['beginRestore']> | undefined;
    await new KeyedQueue().run('alice', async () => {
      entry = archiver.beginRestore(archived);
    });
    // Non-blocking: the row is restoring the moment beginRestore returns.
    expect(findByName(db, 'alice')?.state).toBe('restoring');
    expect(archiver.hasLiveRestore(row.id)).toBe(true);
    expect(entry?.progress.phase).toBe('downloading');

    await archiver.restoreJoin(row.id);

    expect(findByName(db, 'alice')?.state).toBe('active');
    expect(executor.stateOf(row.id)).toBe('running');
    expect((await executor.readFile(row.id, 'kept.txt')).toString()).toBe(
      'data of alice',
    );
    expect(archiver.hasLiveRestore(row.id)).toBe(false);
    // The object goes with the restore: from here "an object exists" means
    // "the row is archived" — release never chases stale copies.
    expect(store.has(objectKey(row.id))).toBe(false);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('a missing archive object reverts the row to archived', async () => {
    const { db, executor, store, tmpDir, archiver } = setup();
    const row = await seedStopped(db, executor, 'alice');
    await archiver.archive(row);
    await store.delete(objectKey(row.id));
    const archived = findByName(db, 'alice');
    if (!archived) throw new Error('row vanished');

    archiver.beginRestore(archived);
    await expect(archiver.restoreJoin(row.id)).rejects.toThrow(
      `archive object ${objectKey(row.id)} is not in bucket`,
    );

    // The S3 object is the only copy; with it gone the honest state is
    // archived-and-failing, retried on every acquire, loudly.
    expect(findByName(db, 'alice')?.state).toBe('archived');
    expect(await executor.listDisks()).not.toContain(row.id);
    expect(archiver.hasLiveRestore(row.id)).toBe(false);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('calling beginRestore twice joins the same task', async () => {
    const { db, executor, archiver } = setup();
    const row = await seedStopped(db, executor, 'alice');
    await archiver.archive(row);
    const archived = findByName(db, 'alice');
    if (!archived) throw new Error('row vanished');

    const first = archiver.beginRestore(archived);
    const again = archiver.beginRestore(findByName(db, 'alice') as SandboxRow);
    expect(again).toBe(first);
    await archiver.restoreJoin(row.id);
    expect(findByName(db, 'alice')?.state).toBe('active');
  });
});

describe('Archiver.restoreJoin', () => {
  it('is a no-op for a sandbox that is not archived', async () => {
    const { db, executor, archiver } = setup();
    const id = randomUUID();
    await executor.create(id);
    createSandbox(db, {
      id,
      name: 'alice',
      nodeId: 'node-test',
      policy: DEFAULT_LIFECYCLE_POLICY,
    });
    await archiver.restoreJoin(id);
    expect(findByName(db, 'alice')?.state).toBe('active');
  });

  it('starts the restore itself when the row is archived', async () => {
    const { db, executor, archiver } = setup();
    const row = await seedStopped(db, executor, 'alice');
    await archiver.archive(row);

    await archiver.restoreJoin(row.id);

    expect(findByName(db, 'alice')?.state).toBe('active');
    expect(executor.stateOf(row.id)).toBe('running');
  });
});
