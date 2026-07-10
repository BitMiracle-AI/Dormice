import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ContractContext } from './index';

/** Container lifecycle, the disk as the sandbox's body, and state gates. */
export function lifecycleTests(ctx: ContractContext) {
  const { timeoutMs } = ctx;

  describe('lifecycle and disks', () => {
    it(
      'walks the full container lifecycle',
      async () => {
        const id = await ctx.fresh();
        expect(await ctx.stateOf(id)).toBe('running');
        await ctx.executor.freeze(id);
        expect(await ctx.stateOf(id)).toBe('paused');
        await ctx.executor.unfreeze(id);
        expect(await ctx.stateOf(id)).toBe('running');
        await ctx.executor.freeze(id);
        await ctx.executor.stop(id);
        expect(await ctx.stateOf(id)).toBe('stopped');
        await ctx.executor.start(id);
        expect(await ctx.stateOf(id)).toBe('running');
      },
      timeoutMs,
    );

    it(
      'rejects creating the same container twice',
      async () => {
        const id = await ctx.fresh();
        await expect(ctx.executor.create(id)).rejects.toThrow(/already exists/);
      },
      timeoutMs,
    );

    it(
      'rejects operations from the wrong state',
      async () => {
        const id = await ctx.fresh();
        await expect(ctx.executor.unfreeze(id)).rejects.toThrow(
          /expected paused/,
        );
        await expect(ctx.executor.stop(id)).rejects.toThrow(/expected paused/);
        await expect(ctx.executor.start(id)).rejects.toThrow(
          /expected stopped/,
        );
      },
      timeoutMs,
    );

    it(
      'rejects operations on absent containers',
      async () => {
        await expect(ctx.executor.freeze(randomUUID())).rejects.toThrow(
          /absent/,
        );
      },
      timeoutMs,
    );

    it(
      'destroys a container from any state',
      async () => {
        const running = await ctx.fresh();
        await ctx.executor.destroy(running);
        expect(await ctx.stateOf(running)).toBeUndefined();

        const paused = await ctx.fresh();
        await ctx.executor.freeze(paused);
        await ctx.executor.destroy(paused);
        expect(await ctx.stateOf(paused)).toBeUndefined();

        const stopped = await ctx.fresh();
        await ctx.executor.freeze(stopped);
        await ctx.executor.stop(stopped);
        await ctx.executor.destroy(stopped);
        expect(await ctx.stateOf(stopped)).toBeUndefined();
      },
      timeoutMs,
    );

    it(
      'rejects destroying an absent container',
      async () => {
        // The ledger says it exists, reality disagrees: worth hearing, not
        // a silent success — vanished containers are the reconciler's case.
        await expect(ctx.executor.destroy(randomUUID())).rejects.toThrow(
          /absent/,
        );
      },
      timeoutMs,
    );

    it(
      'start rebuilds the container from a surviving disk',
      async () => {
        const id = await ctx.freshStopped();
        // The exited container object is removed behind the daemon's back —
        // exactly what a routine `docker container prune` does. The disk,
        // which is the sandbox's actual data, stays.
        await ctx.subject.vanishContainer(id);
        expect(await ctx.stateOf(id)).toBeUndefined();
        expect(await ctx.executor.listDisks()).toContain(id);

        await ctx.executor.start(id);
        expect(await ctx.stateOf(id)).toBe('running');
        expect(await ctx.executor.listDisks()).toContain(id);
      },
      timeoutMs,
    );

    it(
      'destroy of a vanished container still takes the leftover disk',
      async () => {
        const id = await ctx.freshStopped();
        await ctx.subject.vanishContainer(id);

        await ctx.executor.destroy(id);
        expect(await ctx.executor.listDisks()).not.toContain(id);
      },
      timeoutMs,
    );

    it(
      'rejects starting a sandbox that has no disk',
      async () => {
        // No container AND no disk: there is nothing to rebuild from.
        await expect(ctx.executor.start(randomUUID())).rejects.toThrow(
          /disk .+ is absent, cannot start/,
        );
      },
      timeoutMs,
    );

    it(
      'removeContainer swaps the shell: container gone, disk kept, start rebuilds with data intact',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.writeFiles(id, [
          { path: 'keep.txt', content: Buffer.from('survives the rebuild') },
        ]);

        await ctx.executor.removeContainer(id);
        expect(await ctx.stateOf(id)).toBeUndefined();
        expect(await ctx.executor.listDisks()).toContain(id);

        await ctx.executor.start(id);
        expect(await ctx.stateOf(id)).toBe('running');
        expect((await ctx.executor.readFile(id, 'keep.txt')).toString()).toBe(
          'survives the rebuild',
        );
      },
      timeoutMs,
    );

    it(
      'removeContainer takes the container down from any state',
      async () => {
        const paused = await ctx.fresh();
        await ctx.executor.freeze(paused);
        await ctx.executor.removeContainer(paused);
        expect(await ctx.stateOf(paused)).toBeUndefined();
        expect(await ctx.executor.listDisks()).toContain(paused);

        const stopped = await ctx.freshStopped();
        await ctx.executor.removeContainer(stopped);
        expect(await ctx.stateOf(stopped)).toBeUndefined();
        expect(await ctx.executor.listDisks()).toContain(stopped);
      },
      timeoutMs,
    );

    it(
      'removeContainer: an absent container is the goal state beside a disk, a complaint without one',
      async () => {
        const id = await ctx.freshStopped();
        await ctx.subject.vanishContainer(id);
        // Pruned behind the daemon's back — removing it again is a no-op.
        await ctx.executor.removeContainer(id);
        expect(await ctx.executor.listDisks()).toContain(id);

        await expect(
          ctx.executor.removeContainer(randomUUID()),
        ).rejects.toThrow(/absent, cannot remove/);
      },
      timeoutMs,
    );

    it(
      'the disk lives with the container: born on create, kept through stop, gone on destroy',
      async () => {
        const id = await ctx.fresh();
        expect(await ctx.executor.listDisks()).toContain(id);
        await ctx.executor.freeze(id);
        await ctx.executor.stop(id);
        // "The processes die, the disk stays."
        expect(await ctx.executor.listDisks()).toContain(id);
        await ctx.executor.destroy(id);
        expect(await ctx.executor.listDisks()).not.toContain(id);
      },
      timeoutMs,
    );

    it(
      'removeDisk is idempotent: an absent disk already is the goal state',
      async () => {
        await expect(
          ctx.executor.removeDisk(randomUUID()),
        ).resolves.toBeUndefined();
      },
      timeoutMs,
    );

    it(
      'lists every container as an observation, not a live reference',
      async () => {
        const a = await ctx.fresh();
        const b = await ctx.fresh();
        await ctx.executor.freeze(b);

        const observed = await ctx.executor.listContainers();
        expect(observed.get(a)).toBe('running');
        expect(observed.get(b)).toBe('paused');
        // Mutating the observation must not mutate reality.
        observed.delete(a);
        expect(await ctx.stateOf(a)).toBe('running');
      },
      timeoutMs,
    );

    it(
      'resolvePortTarget answers for a running sandbox and refuses the wrong state',
      async () => {
        const id = await ctx.fresh();
        const target = await ctx.executor.resolvePortTarget(id, 8000);
        expect(target.host).not.toBe('');
        expect(target.port).toBeGreaterThan(0);
        await ctx.executor.freeze(id);
        await expect(ctx.executor.resolvePortTarget(id, 8000)).rejects.toThrow(
          `container ${id} is paused, expected running`,
        );
      },
      timeoutMs,
    );
  });
}
