import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';

/**
 * Host-side readings for getHostMetrics — the machine's own health, which
 * no executor can know (executors know sandboxes; the daemon lives on the
 * host). Every reading is a point-in-time snapshot; anything the platform
 * cannot produce is null, never invented — swap and MemAvailable are
 * /proc/meminfo facts, and a Mac dev machine has neither.
 */

export interface HostMemory {
  memTotalBytes: number;
  memAvailableBytes: number;
  swap: { totalBytes: number; usedBytes: number } | null;
}

/**
 * Whole-machine CPU usage as a delta between two samples of the kernel's
 * cumulative per-CPU time counters. One sampler instance per daemon: the
 * delta spans "since the last request", and the very first call honestly
 * answers null — a single sample has no denominator.
 */
export class CpuSampler {
  private last: { idleMs: number; totalMs: number } | null = null;

  /** Percent of the whole machine, 0-100, or null until a delta exists. */
  sample(): number | null {
    let idleMs = 0;
    let totalMs = 0;
    for (const cpu of os.cpus()) {
      idleMs += cpu.times.idle;
      totalMs +=
        cpu.times.user +
        cpu.times.nice +
        cpu.times.sys +
        cpu.times.idle +
        cpu.times.irq;
    }
    const prev = this.last;
    this.last = { idleMs, totalMs };
    // No previous sample, or none of the counters moved yet (two calls
    // inside the same tick) — there is no interval to report on.
    if (!prev || totalMs <= prev.totalMs) return null;
    const busy = totalMs - prev.totalMs - (idleMs - prev.idleMs);
    // Clamp into the reading's own domain: per-CPU counters are sampled
    // one after another, so rounding can push the ratio a hair outside it.
    return Math.min(100, Math.max(0, (busy / (totalMs - prev.totalMs)) * 100));
  }
}

/**
 * /proc/meminfo -> HostMemory, exported for tests. Null when the text does
 * not carry the fields (not a Linux meminfo): the caller falls back to the
 * portable reading.
 */
export function parseMeminfo(text: string): HostMemory | null {
  const kb = (key: string): number | null => {
    const match = text.match(new RegExp(`^${key}: +(\\d+) kB$`, 'm'));
    return match ? Number(match[1]) * 1024 : null;
  };
  const memTotal = kb('MemTotal');
  const memAvailable = kb('MemAvailable');
  if (memTotal === null || memAvailable === null) return null;
  const swapTotal = kb('SwapTotal');
  const swapFree = kb('SwapFree');
  return {
    memTotalBytes: memTotal,
    memAvailableBytes: memAvailable,
    swap:
      swapTotal !== null && swapFree !== null
        ? { totalBytes: swapTotal, usedBytes: swapTotal - swapFree }
        : null,
  };
}

/**
 * On Linux, /proc/meminfo: MemAvailable counts reclaimable page cache
 * (os.freemem() does not — it would cry wolf on any healthy box), and swap
 * lives nowhere else. Elsewhere, the portable os numbers and an honest
 * null for swap.
 */
export async function readHostMemory(): Promise<HostMemory> {
  try {
    const parsed = parseMeminfo(await readFile('/proc/meminfo', 'utf8'));
    if (parsed) return parsed;
  } catch {
    // No /proc here — not a Linux host.
  }
  return {
    memTotalBytes: os.totalmem(),
    memAvailableBytes: os.freemem(),
    swap: null,
  };
}

export interface DiskSpace {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

/**
 * The filesystem holding `dirPath`, df semantics: available is what a
 * non-root writer can still use (bavail, not bfree). Null when the
 * directory does not exist — the fake executor never creates the data
 * dir, and a missing reading must not invent one.
 */
export async function readDiskSpace(
  dirPath: string,
): Promise<DiskSpace | null> {
  let s: Awaited<ReturnType<typeof statfs>>;
  try {
    s = await statfs(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return {
    totalBytes: s.blocks * s.bsize,
    usedBytes: (s.blocks - s.bfree) * s.bsize,
    availableBytes: s.bavail * s.bsize,
  };
}
