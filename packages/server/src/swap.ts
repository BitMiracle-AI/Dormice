import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

/**
 * Daemon-managed swap: block files under `$DATA_DIR/swap/`, grown and
 * mounted so frozen sandboxes have somewhere to squeeze their memory
 * (swap capacity ≈ how much sandbox memory can hibernate at once). The
 * ledger's `swapGb` is the target; this class makes reality match — the
 * same reconcile runs at boot and after every updateSettings, so there is
 * exactly one arbiter of "what should be mounted".
 *
 * The one hard rule: an ACTIVE swapfile is never touched. swapoff would
 * drag every frozen sandbox's memory back into RAM — with a fleet
 * hibernating that can OOM the host — so shrinking only writes the
 * target and waits: after a host reboot nothing is active (swap content
 * never survives a reboot; neither do the frozen sandboxes' containers —
 * the disk is the sandbox's body), the boot reconcile simply activates
 * less and deletes the inactive leftovers. Growing is immediate and
 * cheap: fallocate + mkswap + swapon, seconds.
 *
 * Blocks are append-only history, not a fixed unit: each grow adds one
 * block sized to the missing gap, so a target of 100 GiB is one 100 GiB
 * file, not four of 25. The host's own swap (install.sh's fstab-managed
 * swapfile) is a different jurisdiction — never counted, never touched.
 */

/** One managed block file: `block-<n>` under the swap dir. */
export interface SwapBlock {
  name: string;
  sizeGb: number;
  /** Currently swapon'd (per /proc/swaps). */
  active: boolean;
}

export interface SwapStatus {
  /** GiB of managed swap actually mounted right now. */
  activeGb: number;
  blocks: SwapBlock[];
}

export interface SwapPlan {
  /** Existing inactive blocks to swapon, in index order. */
  activate: string[];
  /** Inactive blocks beyond the target: delete the files. */
  remove: string[];
  /** Size of the one new block to create and mount; null = no gap. */
  createGb: number | null;
  /** GiB active beyond the target — untouchable until a host reboot. */
  deferredGb: number;
}

/**
 * The pure adjudication: given the target and what exists, decide every
 * action. Active blocks are immovable (they all stay, wanted or not);
 * the remaining gap is filled from inactive blocks in index order, each
 * either activated (fits) or deleted (does not), and any gap still left
 * becomes one new block. Deleting only what is inactive AND unwanted is
 * what makes shrink-by-reboot converge: after a reboot nothing is
 * active, so the same rule keeps exactly the target's worth of files.
 */
export function planSwap(targetGb: number, blocks: SwapBlock[]): SwapPlan {
  const activeGb = blocks
    .filter((b) => b.active)
    .reduce((sum, b) => sum + b.sizeGb, 0);
  let remaining = Math.max(0, targetGb - activeGb);
  const activate: string[] = [];
  const remove: string[] = [];
  for (const block of blocks) {
    if (block.active) continue;
    if (block.sizeGb <= remaining && block.sizeGb > 0) {
      activate.push(block.name);
      remaining -= block.sizeGb;
    } else {
      remove.push(block.name);
    }
  }
  return {
    activate,
    remove,
    createGb: remaining > 0 ? remaining : null,
    deferredGb: Math.max(0, activeGb - targetGb),
  };
}

export interface SwapManagerOptions {
  /** The managed directory, `$DATA_DIR/swap` — created on first use. */
  dir: string;
  log: (msg: string) => void;
  /** Test seam; production shells out through execa. */
  run?: (command: string, args: string[]) => Promise<void>;
  /** Test seam; production reads /proc/swaps. */
  procSwapsPath?: string;
}

/** What the routes depend on; SwapManager is the one real implementation. */
export interface SwapControl {
  status(): Promise<SwapStatus>;
  reconcile(targetGb: number): Promise<SwapStatus>;
}

const BLOCK_RE = /^block-(\d+)$/;

export class SwapManager implements SwapControl {
  private readonly dir: string;
  private readonly log: (msg: string) => void;
  private readonly run: NonNullable<SwapManagerOptions['run']>;
  private readonly procSwapsPath: string;
  /** Serializes reconciles: boot and a concurrent updateSettings must not interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: SwapManagerOptions) {
    this.dir = options.dir;
    this.log = options.log;
    this.run =
      options.run ??
      (async (command, args) => {
        await execa(command, args);
      });
    this.procSwapsPath = options.procSwapsPath ?? '/proc/swaps';
  }

  async status(): Promise<SwapStatus> {
    const blocks = await this.listBlocks();
    return {
      activeGb: blocks
        .filter((b) => b.active)
        .reduce((sum, b) => sum + b.sizeGb, 0),
      blocks,
    };
  }

  async reconcile(targetGb: number): Promise<SwapStatus> {
    const result = this.queue.then(() => this.reconcileNow(targetGb));
    // The queue must survive a failed reconcile; the caller still sees it.
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async reconcileNow(targetGb: number): Promise<SwapStatus> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    // A crash between fallocate and the final rename leaves a .tmp — ours,
    // incomplete, safe to sweep.
    for (const entry of await fs.readdir(this.dir)) {
      if (entry.endsWith('.tmp')) await fs.rm(path.join(this.dir, entry));
    }
    const blocks = await this.listBlocks();
    const plan = planSwap(targetGb, blocks);
    for (const name of plan.remove) {
      await fs.rm(path.join(this.dir, name));
    }
    for (const name of plan.activate) {
      await this.run('swapon', [path.join(this.dir, name)]);
    }
    if (plan.createGb !== null) {
      const kept = blocks
        .map((b) => BLOCK_RE.exec(b.name))
        .filter((m): m is RegExpExecArray => m !== null)
        .filter((m) => !plan.remove.includes(m[0]));
      const index = kept.length
        ? Math.max(...kept.map((m) => Number(m[1]))) + 1
        : 0;
      const finalPath = path.join(this.dir, `block-${index}`);
      // Built under a .tmp name and renamed only once mkswap succeeded, so
      // an existing block file is always a valid swap device.
      const tmpPath = `${finalPath}.tmp`;
      await this.run('fallocate', ['-l', `${plan.createGb}GiB`, tmpPath]);
      // Swap holds every process's memory contents; root-only, always.
      await fs.chmod(tmpPath, 0o600);
      await this.run('mkswap', [tmpPath]);
      await fs.rename(tmpPath, finalPath);
      await this.run('swapon', [finalPath]);
    }
    const after = await this.status();
    this.log(
      `swap reconcile: target ${targetGb} GiB, active ${after.activeGb} GiB` +
        (plan.deferredGb > 0
          ? ` (${plan.deferredGb} GiB over target stays mounted until the next host reboot)`
          : ''),
    );
    return after;
  }

  private async listBlocks(): Promise<SwapBlock[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const active = await this.activePaths();
    const blocks: SwapBlock[] = [];
    for (const name of entries) {
      const match = BLOCK_RE.exec(name);
      // Anything else in the dir (stray files, .tmp mid-sweep) is not ours
      // to judge here — never deleted by the planner.
      if (!match) continue;
      const filePath = path.join(this.dir, name);
      let stat: Stats;
      try {
        stat = await fs.stat(filePath);
      } catch (error) {
        // status() deliberately bypasses the reconcile queue (getConfig
        // must not wait behind a fallocate), so a block a concurrent
        // reconcile just deleted can vanish between readdir and stat —
        // then it simply is not a block anymore.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      blocks.push({
        name,
        sizeGb: Math.round(stat.size / 2 ** 30),
        active: active.has(await realpathSafe(filePath)),
      });
    }
    blocks.sort(
      (a, b) =>
        Number(BLOCK_RE.exec(a.name)?.[1]) - Number(BLOCK_RE.exec(b.name)?.[1]),
    );
    return blocks;
  }

  /** Resolved paths of every active swap device, from /proc/swaps. */
  private async activePaths(): Promise<Set<string>> {
    let content: string;
    try {
      content = await fs.readFile(this.procSwapsPath, 'utf8');
    } catch {
      // No /proc/swaps (or unreadable): nothing is knowably active. Only
      // reachable in tests or on non-Linux, where the manager is not built.
      return new Set();
    }
    const paths = new Set<string>();
    for (const line of content.split('\n').slice(1)) {
      const raw = line.split(/\s+/)[0];
      if (!raw?.startsWith('/')) continue;
      // The kernel escapes spaces in filenames as \040.
      const decoded = raw.replaceAll('\\040', ' ');
      paths.add(await realpathSafe(decoded));
    }
    return paths;
  }
}

/** realpath with a fallback for paths that no longer resolve. */
async function realpathSafe(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}
