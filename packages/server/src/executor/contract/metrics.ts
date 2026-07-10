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
}
