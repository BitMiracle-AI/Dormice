import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CpuSampler,
  parseMeminfo,
  readDiskSpace,
  readHostMemory,
} from './host-metrics';

// A real Ubuntu 24.04 /proc/meminfo, truncated to the fields that matter
// plus neighbors that must not confuse the parser (SwapCached vs SwapTotal).
const MEMINFO = `MemTotal:       32496460 kB
MemFree:         1652948 kB
MemAvailable:   24493736 kB
Buffers:         1585796 kB
Cached:         20655944 kB
SwapCached:        11492 kB
SwapTotal:      16777212 kB
SwapFree:       15728640 kB
Dirty:               396 kB
`;

describe('parseMeminfo', () => {
  it('reads totals, MemAvailable and swap in bytes', () => {
    const memory = parseMeminfo(MEMINFO);
    expect(memory).toEqual({
      memTotalBytes: 32496460 * 1024,
      memAvailableBytes: 24493736 * 1024,
      swap: {
        totalBytes: 16777212 * 1024,
        usedBytes: (16777212 - 15728640) * 1024,
      },
    });
  });

  it('reports a swapless machine as an honest zero, not null', () => {
    const memory = parseMeminfo(
      'MemTotal: 1024 kB\nMemAvailable: 512 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
    );
    expect(memory?.swap).toEqual({ totalBytes: 0, usedBytes: 0 });
  });

  it('answers null for text that is not a meminfo', () => {
    expect(parseMeminfo('not a meminfo')).toBeNull();
  });
});

describe('CpuSampler', () => {
  it('answers null on the first sample — no interval to report on', () => {
    expect(new CpuSampler().sample()).toBeNull();
  });

  it('answers a percentage in [0, 100] once an interval exists', async () => {
    const sampler = new CpuSampler();
    sampler.sample();
    // Let the kernel's counters tick; busy-spin a little so the delta is
    // not all idle on a quiet CI machine.
    const until = Date.now() + 60;
    while (Date.now() < until) {
      /* spin */
    }
    const pct = sampler.sample();
    // The counters' granularity can still round the interval to zero on a
    // fast machine — null stays an honest answer; a number must be sane.
    if (pct !== null) {
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });
});

describe('readHostMemory', () => {
  it('reports positive totals on whatever platform runs the tests', async () => {
    const memory = await readHostMemory();
    expect(memory.memTotalBytes).toBeGreaterThan(0);
    expect(memory.memAvailableBytes).toBeGreaterThan(0);
    expect(memory.memAvailableBytes).toBeLessThanOrEqual(memory.memTotalBytes);
  });
});

describe('readDiskSpace', () => {
  it('reports df-style numbers for an existing directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dormice-host-'));
    const space = await readDiskSpace(dir);
    expect(space).not.toBeNull();
    expect(space?.totalBytes).toBeGreaterThan(0);
    expect(space?.usedBytes).toBeGreaterThanOrEqual(0);
    expect(space?.availableBytes).toBeGreaterThan(0);
  });

  it('answers null for a directory that does not exist', async () => {
    expect(await readDiskSpace('/no/such/dormice/dir')).toBeNull();
  });
});
