import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { type DiskSpace, readDiskSpace } from './host-metrics';

/**
 * Host data-disk auto-grow: when the block device under DORMICE_DATA_DIR
 * is bigger than the filesystem on it, grow the filesystem. A cloud disk
 * expansion only enlarges the device — the filesystem never claims new
 * space by itself, and the platform's whole disk budget (sandbox disks,
 * archives, the ledger) sits on this one filesystem, so "expanded the
 * disk, nothing changed, now it's 98% full" is the first wall every
 * self-hoster hits. The generic OS cannot do this automatically because
 * it cannot know the layout; we CAN know ours, so we adjudicate it.
 *
 * The adjudication is deliberately narrow (the swap manager's stance:
 * eligibility first, honest reasons when not): the daemon only grows a
 * filesystem it can fully reason about — an ext4 written directly onto a
 * whole disk, no partition table, no device-mapper layers. Anything else
 * means the operator has their own layout and their own tools; we say why
 * we are not touching it, once, and stand back.
 *
 * resize2fs is the single arbiter of "is there space to claim": it reads
 * the superblock itself and no-ops when the filesystem already fills the
 * device, so this module never compares filesystem bytes to device bytes
 * (statfs undercounts by the ext4 metadata overhead — a homemade
 * threshold would either misfire or go blind). We only gate the SPAWN: a
 * check runs resize2fs exactly when the device's size differs from the
 * last size we adjudicated, which makes the whole thing crash-only — no
 * persisted state, a restart simply re-adjudicates once. Grow-only by
 * physics: online ext4 can never shrink, so the worst this can do is
 * exactly what the operator already asked for by growing the device.
 */

export type DiskGrowCheck =
  /** The layout is not ours to manage; reason says why (logged once). */
  | { outcome: 'ineligible'; reason: string }
  /** Device size unchanged since the last adjudication, or resize2fs no-oped. */
  | { outcome: 'settled' }
  | { outcome: 'grown'; fromBytes: number; toBytes: number }
  /** resize2fs failed; not retried until the device changes size again. */
  | { outcome: 'failed'; error: string };

export interface MountFacts {
  mountPoint: string;
  fsType: string;
  source: string;
}

/**
 * The mount that holds `dirRealPath`, from /proc/self/mountinfo: the entry
 * with the longest mount point that is a path-prefix of the directory.
 * Fields per proc(5): mount point is field 5; after the lone `-` separator
 * come fstype and source. The kernel escapes space/tab/newline/backslash
 * as octal in the mount point.
 */
export function findMount(
  mountinfo: string,
  dirRealPath: string,
): MountFacts | null {
  let best: MountFacts | null = null;
  for (const line of mountinfo.split('\n')) {
    const tokens = line.split(' ');
    const sep = tokens.indexOf('-');
    const rawMountPoint = tokens[4];
    const fsType = tokens[sep + 1];
    const source = tokens[sep + 2];
    if (sep < 5 || !rawMountPoint || !fsType || !source) continue;
    const mountPoint = rawMountPoint.replace(/\\(\d{3})/g, (_, oct) =>
      String.fromCharCode(Number.parseInt(oct, 8)),
    );
    const covers =
      mountPoint === '/' ||
      dirRealPath === mountPoint ||
      dirRealPath.startsWith(`${mountPoint}/`);
    if (!covers) continue;
    if (best === null || mountPoint.length > best.mountPoint.length) {
      best = { mountPoint, fsType, source };
    }
  }
  return best;
}

export interface HostDiskGrowerOptions {
  /** DORMICE_DATA_DIR — the filesystem under it is the one we manage. */
  dataDir: string;
  log: (msg: string) => void;
  /** Test seam; production shells out through execa. */
  run?: (command: string, args: string[]) => Promise<void>;
  /** Test seam; production reads /proc/self/mountinfo. */
  mountinfoPath?: string;
  /** Test seam; production reads /sys/class/block. */
  sysBlockDir?: string;
  /** Test seam; production statfs-reads the data dir. */
  readDisk?: (dirPath: string) => Promise<DiskSpace | null>;
}

export class HostDiskGrower {
  private readonly dataDir: string;
  private readonly log: (msg: string) => void;
  private readonly run: NonNullable<HostDiskGrowerOptions['run']>;
  private readonly mountinfoPath: string;
  private readonly sysBlockDir: string;
  private readonly readDisk: NonNullable<HostDiskGrowerOptions['readDisk']>;
  /**
   * The device size (bytes) this instance last adjudicated — resize2fs ran
   * (or failed) against it, nothing to redo until the device changes. In
   * memory only, so every boot re-adjudicates once: that is also what
   * catches a disk expanded while the daemon was down.
   */
  private settledDeviceBytes: number | null = null;
  /** Last ineligibility logged, so a stable layout is said no to once. */
  private loggedReason: string | null = null;

  constructor(options: HostDiskGrowerOptions) {
    this.dataDir = options.dataDir;
    this.log = options.log;
    this.run =
      options.run ??
      (async (command, args) => {
        await execa(command, args);
      });
    this.mountinfoPath = options.mountinfoPath ?? '/proc/self/mountinfo';
    this.sysBlockDir = options.sysBlockDir ?? '/sys/class/block';
    this.readDisk = options.readDisk ?? readDiskSpace;
  }

  /** Never throws: a failed reading is an ineligibility, said honestly. */
  async check(): Promise<DiskGrowCheck> {
    let judged: DiskGrowCheck;
    try {
      judged = await this.checkNow();
    } catch (error) {
      judged = {
        outcome: 'ineligible',
        reason: `cannot read the disk layout: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (
      judged.outcome === 'ineligible' &&
      judged.reason !== this.loggedReason
    ) {
      this.loggedReason = judged.reason;
      this.log(`data disk auto-grow off: ${judged.reason}`);
    }
    return judged;
  }

  private async checkNow(): Promise<DiskGrowCheck> {
    const dirReal = await fs.realpath(this.dataDir);
    const mount = findMount(
      await fs.readFile(this.mountinfoPath, 'utf8'),
      dirReal,
    );
    if (!mount) {
      return { outcome: 'ineligible', reason: `no mount found for ${dirReal}` };
    }
    if (mount.fsType !== 'ext4') {
      return {
        outcome: 'ineligible',
        reason: `${mount.mountPoint} is ${mount.fsType}, only ext4 is managed`,
      };
    }
    // Resolve symlink shapes (/dev/disk/by-uuid/…, /dev/mapper/…) to the
    // kernel name that /sys/class/block indexes.
    const device = await realpathSafe(mount.source);
    if (!device.startsWith('/dev/')) {
      return {
        outcome: 'ineligible',
        reason: `${mount.mountPoint} is not backed by a block device (${mount.source})`,
      };
    }
    const name = path.basename(device);
    const sysDir = path.join(this.sysBlockDir, name);
    if (await exists(path.join(sysDir, 'partition'))) {
      return {
        outcome: 'ineligible',
        reason: `${device} is a partition — growing it needs a partition-table edit first (growpart), which is the operator's call`,
      };
    }
    if (await hasEntries(path.join(sysDir, 'slaves'))) {
      return {
        outcome: 'ineligible',
        reason: `${device} is a layered device (LVM/md) — its stack is the operator's to grow`,
      };
    }
    const sectors = Number(
      (await fs.readFile(path.join(sysDir, 'size'), 'utf8')).trim(),
    );
    if (!Number.isFinite(sectors) || sectors <= 0) {
      return { outcome: 'ineligible', reason: `${device} reports no size` };
    }
    const deviceBytes = sectors * 512;
    if (deviceBytes === this.settledDeviceBytes) return { outcome: 'settled' };

    const before = await this.readDisk(this.dataDir);
    try {
      await this.run('resize2fs', [device]);
    } catch (error) {
      // Settle on this size anyway: a deterministic failure will not fix
      // itself, so retrying every tick is pure noise — the next device
      // resize (or a daemon restart) is the retry trigger.
      this.settledDeviceBytes = deviceBytes;
      const message = error instanceof Error ? error.message : String(error);
      this.log(`data disk auto-grow: resize2fs ${device} failed: ${message}`);
      return { outcome: 'failed', error: message };
    }
    this.settledDeviceBytes = deviceBytes;
    const after = await this.readDisk(this.dataDir);
    if (before && after && after.totalBytes > before.totalBytes) {
      this.log(
        `data disk auto-grow: ${device} grew, filesystem now ${gib(after.totalBytes)} GiB (was ${gib(before.totalBytes)} GiB)`,
      );
      return {
        outcome: 'grown',
        fromBytes: before.totalBytes,
        toBytes: after.totalBytes,
      };
    }
    return { outcome: 'settled' };
  }
}

export function gib(bytes: number): string {
  return (bytes / 2 ** 30).toFixed(1);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** True when the directory exists and holds anything (dm/md slave links). */
async function hasEntries(p: string): Promise<boolean> {
  try {
    return (await fs.readdir(p)).length > 0;
  } catch {
    return false;
  }
}

async function realpathSafe(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}
