import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIFECYCLE_POLICY } from '@dormice/shared';
import { describe, expect, it, vi } from 'vitest';
import { type Db, migrateDb, openDb } from './db/db';
import { createSandbox, transition } from './db/ledger';
import type { SandboxRow } from './db/schema';
import { FakeExecutor } from './executor/fake';
import { KeyedQueue } from './keyed-queue';
import { sweepPidsLimit } from './pids-sweep';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * The daemon's wiring in miniature: the executor reads the cap from a live
 * view, and the test plays the ledger by moving that view — exactly what
 * an updateSettings write or an upgrade's adopt step does.
 */
function setup(cap: number) {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  const view = { cap };
  const executor = new FakeExecutor(undefined, () => view.cap);
  return { db, executor, locks: new KeyedQueue(), view };
}

/** A healthy sandbox: shell running, row active. */
async function seed(
  db: Db,
  executor: FakeExecutor,
  name: string,
): Promise<SandboxRow> {
  const id = randomUUID();
  await executor.create(id);
  return createSandbox(db, {
    id,
    name,
    nodeId: 'node-test',
    policy: DEFAULT_LIFECYCLE_POLICY,
  });
}

describe('sweepPidsLimit', () => {
  it('moves running shells to the cap in place and leaves frozen and stopped ones to their wake', async () => {
    const { db, executor, locks, view } = setup(512);
    const busy = await seed(db, executor, 'busy');
    const frozen = await seed(db, executor, 'frozen');
    await executor.freeze(frozen.id);
    transition(db, frozen.id, 'frozen');
    const stopped = await seed(db, executor, 'stopped');
    await executor.freeze(stopped.id);
    transition(db, stopped.id, 'frozen');
    await executor.stop(stopped.id);
    transition(db, stopped.id, 'stopped');

    view.cap = 4096;
    expect(await sweepPidsLimit(db, executor, locks)).toEqual({
      considered: 1,
      updated: 1,
      skipped: 0,
      failures: [],
    });
    expect(executor.pidsLimitOf(busy.id)).toBe(4096);
    expect(executor.stateOf(busy.id)).toBe('running');
    // Not considered, not touched — the wake is where these converge.
    expect(executor.pidsLimitOf(frozen.id)).toBe(512);
    expect(executor.pidsLimitOf(stopped.id)).toBe(512);
    await executor.unfreeze(frozen.id);
    expect(executor.pidsLimitOf(frozen.id)).toBe(4096);
    await executor.start(stopped.id);
    expect(executor.pidsLimitOf(stopped.id)).toBe(4096);

    // A second pass finds everything in force: nothing counted, nothing done.
    expect(await sweepPidsLimit(db, executor, locks)).toEqual({
      considered: 1,
      updated: 0,
      skipped: 0,
      failures: [],
    });
  });

  it('waits for a busy key instead of skipping it, passes over a row whose shell has died, and counts progress for the watchdog', async () => {
    const { db, executor, locks, view } = setup(512);
    const held = await seed(db, executor, 'held');
    const dead = await seed(db, executor, 'dead');
    const free = await seed(db, executor, 'free');
    // Whoever holds the key is mid-operation (an acquire's touch, an exec's
    // wake). The sweep decides nothing until the slot is its own, so it
    // waits rather than leave this one running shell at the old cap — a
    // skip here would have no next moment to catch it. The dead one is the
    // reconciler's case, not the sweep's.
    let release: () => void = () => {};
    const holding = locks.run(
      held.name,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    executor.crashContainer(dead.id, {
      exitCode: 2,
      oomKilled: false,
      runtimeDied: true,
    });
    const beats = vi.fn();

    view.cap = 4096;
    const sweeping = sweepPidsLimit(db, executor, locks, beats);
    // Queued behind the holder, not around it: the held shell is untouched
    // for as long as the slot is taken.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executor.pidsLimitOf(held.id)).toBe(512);
    release();
    await holding;
    expect(await sweeping).toEqual({
      considered: 3,
      updated: 2,
      skipped: 1,
      failures: [],
    });
    expect(beats).toHaveBeenCalledTimes(3);
    expect(executor.pidsLimitOf(held.id)).toBe(4096);
    expect(executor.pidsLimitOf(free.id)).toBe(4096);
  });

  it('records a refused shell by name and still visits the rest', async () => {
    const { db, executor, locks, view } = setup(512);
    const stubborn = await seed(db, executor, 'stubborn');
    const willing = await seed(db, executor, 'willing');
    const real = executor.convergePidsLimit.bind(executor);
    vi.spyOn(executor, 'convergePidsLimit').mockImplementation((id) =>
      id === stubborn.id
        ? Promise.reject(new Error('runsc refused'))
        : real(id),
    );

    view.cap = 4096;
    expect(await sweepPidsLimit(db, executor, locks)).toEqual({
      considered: 2,
      updated: 1,
      skipped: 0,
      failures: ['stubborn: runsc refused'],
    });
    expect(executor.pidsLimitOf(willing.id)).toBe(4096);
    expect(executor.pidsLimitOf(stubborn.id)).toBe(512);
  });
});
