import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findMount, HostDiskGrower } from './host-disk';
import type { DiskSpace } from './host-metrics';

describe('findMount', () => {
  const info = [
    '25 1 259:4 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p3 rw',
    '96 25 259:1 / /var/lib/dormice rw,relatime shared:50 - ext4 /dev/nvme1n1 rw',
    '31 25 0:27 / /sys/fs/cgroup rw shared:9 - cgroup2 cgroup2 rw',
  ].join('\n');

  it('picks the longest mount point covering the directory', () => {
    expect(findMount(info, '/var/lib/dormice/mnt/abc')).toEqual({
      mountPoint: '/var/lib/dormice',
      fsType: 'ext4',
      source: '/dev/nvme1n1',
    });
  });

  it('falls back to / for a directory with no dedicated mount', () => {
    expect(findMount(info, '/root/dormice')?.source).toBe('/dev/nvme0n1p3');
  });

  it('does not treat a sibling prefix as a parent (/var/lib/dor)', () => {
    expect(findMount(info, '/var/lib/dor')?.mountPoint).toBe('/');
  });

  it('survives optional fields of any width and decodes octal escapes', () => {
    const line =
      '96 25 259:1 / /mnt/data\\040dir rw shared:50 master:2 propagate_from:1 - ext4 /dev/vdb rw';
    expect(findMount(line, '/mnt/data dir/x')).toEqual({
      mountPoint: '/mnt/data dir',
      fsType: 'ext4',
      source: '/dev/vdb',
    });
  });

  it('answers null for an empty or garbage table', () => {
    expect(findMount('', '/anywhere')).toBeNull();
    expect(findMount('not a mountinfo line', '/anywhere')).toBeNull();
  });
});

describe('HostDiskGrower', () => {
  let dir: string;
  let dataDir: string;
  let sysBlockDir: string;
  let mountinfoPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dormice-hostdisk-'));
    dataDir = path.join(dir, 'data');
    sysBlockDir = path.join(dir, 'sys');
    mountinfoPath = path.join(dir, 'mountinfo');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(sysBlockDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A mountinfo whose one entry mounts the (real) data dir. */
  async function writeMount(opts?: { fsType?: string; source?: string }) {
    const real = await fs.realpath(dataDir);
    await fs.writeFile(
      mountinfoPath,
      `96 25 259:1 / ${real} rw,relatime shared:50 - ${opts?.fsType ?? 'ext4'} ${opts?.source ?? '/dev/fakedisk'} rw\n`,
    );
  }

  /** A /sys/class/block/<name> with the given size (bytes / 512 sectors). */
  async function writeDevice(
    name: string,
    bytes: number,
    opts?: { partition?: boolean; slaves?: string[] },
  ) {
    const devDir = path.join(sysBlockDir, name);
    await fs.mkdir(devDir, { recursive: true });
    await fs.writeFile(path.join(devDir, 'size'), `${bytes / 512}\n`);
    if (opts?.partition)
      await fs.writeFile(path.join(devDir, 'partition'), '1\n');
    if (opts?.slaves) {
      await fs.mkdir(path.join(devDir, 'slaves'), { recursive: true });
      for (const s of opts.slaves) {
        await fs.writeFile(path.join(devDir, 'slaves', s), '');
      }
    }
  }

  function build(opts?: { disks?: DiskSpace[]; fail?: boolean }): {
    grower: HostDiskGrower;
    ran: string[][];
    logged: string[];
  } {
    const ran: string[][] = [];
    const logged: string[] = [];
    const disks = [...(opts?.disks ?? [])];
    const grower = new HostDiskGrower({
      dataDir,
      log: (msg) => logged.push(msg),
      run: async (command, args) => {
        ran.push([command, ...args]);
        if (opts?.fail) throw new Error('resize2fs: permission denied');
      },
      mountinfoPath,
      sysBlockDir,
      // Each read consumes the next scripted statfs view; the last one
      // sticks (before/after pairs around every resize2fs).
      readDisk: async () =>
        (disks.length > 1 ? disks.shift() : disks[0]) ?? null,
    });
    return { grower, ran, logged };
  }

  const space = (totalGb: number): DiskSpace => ({
    totalBytes: totalGb * 2 ** 30,
    usedBytes: 2 ** 30,
    availableBytes: (totalGb - 1) * 2 ** 30,
  });

  it('grows: runs resize2fs on the device and reports from/to', async () => {
    await writeMount();
    await writeDevice('fakedisk', 4096 * 2 ** 30);
    const { grower, ran } = build({ disks: [space(2048), space(4096)] });
    const result = await grower.check();
    expect(result).toEqual({
      outcome: 'grown',
      fromBytes: 2048 * 2 ** 30,
      toBytes: 4096 * 2 ** 30,
    });
    expect(ran).toEqual([['resize2fs', '/dev/fakedisk']]);
  });

  it('settles: an unchanged device size never respawns resize2fs', async () => {
    await writeMount();
    await writeDevice('fakedisk', 2048 * 2 ** 30);
    const { grower, ran } = build({ disks: [space(2048)] });
    // First check always adjudicates once (that is what catches a disk
    // expanded while the daemon was down); resize2fs no-ops, statfs is
    // unchanged, so it reads as settled.
    expect((await grower.check()).outcome).toBe('settled');
    expect((await grower.check()).outcome).toBe('settled');
    expect(ran).toHaveLength(1);
  });

  it('re-adjudicates when the device grows between checks', async () => {
    await writeMount();
    await writeDevice('fakedisk', 2048 * 2 ** 30);
    const { grower, ran } = build({
      disks: [space(2048), space(2048), space(2048), space(4096)],
    });
    await grower.check();
    await writeDevice('fakedisk', 4096 * 2 ** 30);
    const result = await grower.check();
    expect(result.outcome).toBe('grown');
    expect(ran).toHaveLength(2);
  });

  it('a failed resize2fs is not retried until the device changes size', async () => {
    await writeMount();
    await writeDevice('fakedisk', 4096 * 2 ** 30);
    const { grower, ran, logged } = build({ disks: [space(2048)], fail: true });
    const first = await grower.check();
    expect(first.outcome).toBe('failed');
    expect((await grower.check()).outcome).toBe('settled');
    expect(ran).toHaveLength(1);
    expect(logged.some((l) => l.includes('permission denied'))).toBe(true);
    // The next expansion is the retry trigger.
    await writeDevice('fakedisk', 8192 * 2 ** 30);
    expect((await grower.check()).outcome).toBe('failed');
    expect(ran).toHaveLength(2);
  });

  it('refuses a non-ext4 filesystem, with the reason logged once', async () => {
    await writeMount({ fsType: 'xfs' });
    const { grower, ran, logged } = build();
    const result = await grower.check();
    expect(result).toMatchObject({ outcome: 'ineligible' });
    if (result.outcome === 'ineligible') {
      expect(result.reason).toContain('xfs');
    }
    await grower.check();
    expect(logged.filter((l) => l.includes('auto-grow off'))).toHaveLength(1);
    expect(ran).toHaveLength(0);
  });

  it('refuses a partition — growpart is the operator’s call', async () => {
    await writeMount({ source: '/dev/fakedisk1' });
    await writeDevice('fakedisk1', 100 * 2 ** 30, { partition: true });
    const { grower, ran } = build();
    const result = await grower.check();
    expect(result.outcome).toBe('ineligible');
    if (result.outcome === 'ineligible') {
      expect(result.reason).toContain('partition');
    }
    expect(ran).toHaveLength(0);
  });

  it('refuses a layered device (LVM/md slaves)', async () => {
    await writeMount({ source: '/dev/dm-0' });
    await writeDevice('dm-0', 100 * 2 ** 30, { slaves: ['nvme1n1'] });
    const { grower } = build();
    const result = await grower.check();
    expect(result.outcome).toBe('ineligible');
    if (result.outcome === 'ineligible') {
      expect(result.reason).toContain('layered');
    }
  });

  it('refuses a source outside /dev (tmpfs, network fs)', async () => {
    await writeMount({ source: 'tmpfs' });
    const { grower } = build();
    expect((await grower.check()).outcome).toBe('ineligible');
  });

  it('never throws: an unreadable mountinfo is an honest ineligibility', async () => {
    // mountinfoPath was never written.
    const { grower, logged } = build();
    expect((await grower.check()).outcome).toBe('ineligible');
    expect(logged.some((l) => l.includes('auto-grow off'))).toBe(true);
  });
});
