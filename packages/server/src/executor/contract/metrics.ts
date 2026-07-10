import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ContractContext } from './index';

/**
 * The metrics verb: a point-in-time reading. Numbers differ per runtime, so
 * the exam checks invariants — proportions, growth, the state gate — never
 * absolute values.
 */
export function metricsTests(ctx: ContractContext) {
  const { timeoutMs } = ctx;

  describe('metrics', () => {
    it(
      'metrics reports sane proportions on a fresh sandbox',
      async () => {
        const id = await ctx.fresh();
        const m = await ctx.executor.metrics(id);
        expect(Number.isInteger(m.cpuCount)).toBe(true);
        expect(m.cpuCount).toBeGreaterThanOrEqual(1);
        expect(m.cpuUsedPct).toBeGreaterThanOrEqual(0);
        expect(m.memTotalBytes).toBeGreaterThan(0);
        expect(m.memUsedBytes).toBeGreaterThanOrEqual(0);
        expect(m.memUsedBytes).toBeLessThanOrEqual(m.memTotalBytes);
        expect(m.memCacheBytes).toBeGreaterThanOrEqual(0);
        expect(m.diskTotalBytes).toBeGreaterThan(0);
        expect(m.diskUsedBytes).toBeGreaterThanOrEqual(0);
        expect(m.diskUsedBytes).toBeLessThanOrEqual(m.diskTotalBytes);
      },
      timeoutMs,
    );

    it(
      'disk usage grows after writing a file',
      async () => {
        const id = await ctx.fresh();
        const before = await ctx.executor.metrics(id);
        await ctx.executor.writeFiles(id, [
          { path: 'metrics-blob.bin', content: Buffer.alloc(2 * 1024 ** 2, 7) },
        ]);
        // Re-read until the filesystem's accounting catches up — ext4 may
        // settle delayed allocations a beat after the write returns.
        let after = await ctx.executor.metrics(id);
        const deadline = Date.now() + timeoutMs - 1_000;
        while (
          after.diskUsedBytes <= before.diskUsedBytes &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          after = await ctx.executor.metrics(id);
        }
        expect(after.diskUsedBytes).toBeGreaterThan(before.diskUsedBytes);
      },
      timeoutMs,
    );

    it(
      'a paused sandbox still reports metrics — observation must not require waking',
      async () => {
        const id = await ctx.fresh();
        await ctx.executor.freeze(id);
        const m = await ctx.executor.metrics(id);
        expect(m.memTotalBytes).toBeGreaterThan(0);
        expect(m.diskTotalBytes).toBeGreaterThan(0);
        // Reading is not waking: the container is still paused afterwards.
        expect(await ctx.stateOf(id)).toBe('paused');
      },
      timeoutMs,
    );

    it(
      'metrics refuses a stopped or absent sandbox',
      async () => {
        const stopped = await ctx.freshStopped();
        await expect(ctx.executor.metrics(stopped)).rejects.toThrow(
          `container ${stopped} is stopped, expected running or paused`,
        );
        const ghost = randomUUID();
        await expect(ctx.executor.metrics(ghost)).rejects.toThrow(
          `container ${ghost} is absent, expected running or paused`,
        );
      },
      timeoutMs,
    );
  });

  describe('diskUsage', () => {
    it(
      'starts at zero and counts each disk once',
      async () => {
        expect(await ctx.executor.diskUsage()).toEqual({
          count: 0,
          nominalBytes: 0,
          actualBytes: 0,
        });
        const first = await ctx.fresh();
        const one = await ctx.executor.diskUsage();
        expect(one.count).toBe(1);
        expect(one.nominalBytes).toBeGreaterThan(0);
        await ctx.fresh();
        const two = await ctx.executor.diskUsage();
        expect(two.count).toBe(2);
        // Every disk is promised the same size, so two disks cost exactly
        // twice the nominal — an invariant that holds whatever the size is.
        expect(two.nominalBytes).toBe(2 * one.nominalBytes);
        await ctx.executor.destroy(first);
        expect((await ctx.executor.diskUsage()).count).toBe(1);
      },
      timeoutMs,
    );

    it(
      'a fresh disk occupies far less than its nominal size — sparseness is the overcommit',
      async () => {
        await ctx.fresh();
        const usage = await ctx.executor.diskUsage();
        expect(usage.actualBytes).toBeGreaterThan(0);
        expect(usage.actualBytes).toBeLessThan(usage.nominalBytes);
      },
      timeoutMs,
    );

    it(
      'actual usage grows after writing a file',
      async () => {
        const id = await ctx.fresh();
        const before = await ctx.executor.diskUsage();
        await ctx.executor.writeFiles(id, [
          { path: 'usage-blob.bin', content: Buffer.alloc(2 * 1024 ** 2, 7) },
        ]);
        // Same patience as the metrics growth test: ext4 may settle the
        // sparse image's newly allocated blocks a beat after the write.
        let after = await ctx.executor.diskUsage();
        const deadline = Date.now() + timeoutMs - 1_000;
        while (
          after.actualBytes <= before.actualBytes &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          after = await ctx.executor.diskUsage();
        }
        expect(after.actualBytes).toBeGreaterThan(before.actualBytes);
      },
      timeoutMs,
    );

    it(
      'a stopped sandbox and a vanished container still count — the disk is the body',
      async () => {
        const id = await ctx.freshStopped();
        expect((await ctx.executor.diskUsage()).count).toBe(1);
        await ctx.subject.vanishContainer(id);
        expect((await ctx.executor.diskUsage()).count).toBe(1);
      },
      timeoutMs,
    );
  });
}
