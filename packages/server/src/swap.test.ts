import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planSwap, type SwapBlock, SwapManager } from './swap';

const block = (name: string, sizeGb: number, active: boolean): SwapBlock => ({
  name,
  sizeGb,
  active,
});

describe('planSwap', () => {
  it('does nothing at target 0 with nothing on disk', () => {
    expect(planSwap(0, [])).toEqual({
      activate: [],
      remove: [],
      createGb: null,
      deferredGb: 0,
    });
  });

  it('creates one block sized to the whole gap', () => {
    expect(planSwap(100, []).createGb).toBe(100);
  });

  it('after a host reboot, keeps the target worth of files and deletes the rest', () => {
    // Nothing is active after a reboot; the shrink written before it now
    // converges: 48 wanted, [32, 32] on disk.
    const plan = planSwap(48, [
      block('block-0', 32, false),
      block('block-1', 32, false),
    ]);
    expect(plan.activate).toEqual(['block-0']);
    expect(plan.remove).toEqual(['block-1']);
    expect(plan.createGb).toBe(16);
    expect(plan.deferredGb).toBe(0);
  });

  it('never touches active blocks: a shrink defers instead', () => {
    const plan = planSwap(32, [
      block('block-0', 32, true),
      block('block-1', 64, true),
    ]);
    expect(plan.activate).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.createGb).toBeNull();
    expect(plan.deferredGb).toBe(64);
  });

  it('grows past what is already mounted with one new block', () => {
    const plan = planSwap(96, [block('block-0', 32, true)]);
    expect(plan.createGb).toBe(64);
    expect(plan.deferredGb).toBe(0);
  });

  it('counts stuck over-target actives toward the total instead of piling on', () => {
    // Daemon restart (not reboot): 64 GiB is still mounted, target 48.
    // Creating 16 more would make reality WORSE (80 mounted).
    const plan = planSwap(48, [
      block('block-0', 32, true),
      block('block-1', 32, true),
    ]);
    expect(plan.createGb).toBeNull();
    expect(plan.deferredGb).toBe(16);
  });

  it('deletes an inactive zero-size block instead of activating it', () => {
    const plan = planSwap(4, [block('block-0', 0, false)]);
    expect(plan.remove).toEqual(['block-0']);
    expect(plan.createGb).toBe(4);
  });
});

describe('SwapManager', () => {
  let dir: string;
  let swapDir: string;
  let procSwaps: string;
  let commands: string[][];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dormice-swap-'));
    swapDir = path.join(dir, 'swap');
    procSwaps = path.join(dir, 'proc-swaps');
    await fs.writeFile(
      procSwaps,
      'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n',
    );
    commands = [];
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // A stand-in for the three util-linux calls: fallocate materializes the
  // file at the asked size (sparse — fine for tests), swapon registers the
  // block in the fake /proc/swaps, mkswap is a no-op. swapoff is absent on
  // purpose: the manager must never even try it.
  function manager() {
    return new SwapManager({
      dir: swapDir,
      log: () => {},
      procSwapsPath: procSwaps,
      run: async (command, args) => {
        commands.push([command, ...args]);
        const target = args.at(-1) ?? '';
        if (command === 'fallocate') {
          const bytes = Number(/^(\d+)GiB$/.exec(args[1] ?? '')?.[1]) * 2 ** 30;
          const handle = await fs.open(target, 'w');
          await handle.truncate(bytes);
          await handle.close();
        }
        if (command === 'swapon') {
          const real = await fs.realpath(target);
          await fs.appendFile(procSwaps, `${real} file 1 0 -2\n`);
        }
        if (command === 'swapoff') {
          throw new Error('swapoff must never be invoked');
        }
      },
    });
  }

  /** Simulates a host reboot: swap never survives one. */
  async function reboot() {
    await fs.writeFile(
      procSwaps,
      'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n',
    );
  }

  it('creates, grows, shrinks-by-reboot — the full life', async () => {
    const swap = manager();

    // Birth: one block of exactly the target.
    expect((await swap.reconcile(3)).activeGb).toBe(3);
    expect(commands.map((c) => c[0])).toEqual([
      'fallocate',
      'mkswap',
      'swapon',
    ]);
    // Built under .tmp and renamed: what exists is always a valid device.
    expect(await fs.readdir(swapDir)).toEqual(['block-0']);

    // Grow: one more block for the gap, the mounted one untouched.
    expect((await swap.reconcile(5)).activeGb).toBe(5);
    expect((await fs.readdir(swapDir)).sort()).toEqual(['block-0', 'block-1']);

    // Shrink while mounted: nothing moves, honestly reported.
    commands = [];
    const shrunk = await swap.reconcile(3);
    expect(shrunk.activeGb).toBe(5);
    expect(commands).toEqual([]);

    // Reboot: the same reconcile now converges — 3 GiB mounted, rest gone.
    await reboot();
    const converged = await swap.reconcile(3);
    expect(converged.activeGb).toBe(3);
    expect(await fs.readdir(swapDir)).toEqual(['block-0']);
  });

  it('remounts existing blocks at boot without recreating them', async () => {
    const swap = manager();
    await swap.reconcile(4);
    await reboot();
    commands = [];
    expect((await swap.reconcile(4)).activeGb).toBe(4);
    // Only swapon — no fallocate, no mkswap: the file was already a device.
    expect(commands.map((c) => c[0])).toEqual(['swapon']);
  });

  it('sweeps its own .tmp leftovers and leaves foreign files alone', async () => {
    await fs.mkdir(swapDir, { recursive: true });
    await fs.writeFile(path.join(swapDir, 'block-7.tmp'), 'crashed mid-create');
    await fs.writeFile(path.join(swapDir, 'notes.txt'), 'not ours to judge');
    const swap = manager();
    await swap.reconcile(0);
    expect((await fs.readdir(swapDir)).sort()).toEqual(['notes.txt']);
  });

  it('skips a block path that vanishes between readdir and stat', async () => {
    // status() bypasses the reconcile queue, so a concurrent reconcile can
    // delete a block mid-listing. A dangling symlink is the deterministic
    // stand-in for that race: readdir sees the name, stat gets ENOENT.
    await fs.mkdir(swapDir, { recursive: true });
    await fs.symlink(path.join(dir, 'gone'), path.join(swapDir, 'block-3'));
    const status = await manager().status();
    expect(status.blocks).toEqual([]);
  });

  it('reports status without mutating anything', async () => {
    const swap = manager();
    await swap.reconcile(2);
    commands = [];
    const status = await swap.status();
    expect(status.activeGb).toBe(2);
    expect(status.blocks).toEqual([
      { name: 'block-0', sizeGb: 2, active: true },
    ]);
    expect(commands).toEqual([]);
  });
});
