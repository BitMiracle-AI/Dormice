import { access, chown, mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import Docker from 'dockerode';
import { execa } from 'execa';
import type { ContainerState, Executor } from './executor';

/**
 * Label that marks a container as ours, holding the sandbox id. Listing by
 * this label is how reconciliation claims Dormice's containers and ignores
 * whatever else runs on the machine.
 */
export const SANDBOX_LABEL = 'dormice.sandbox';

export interface DockerExecutorOptions {
  /** Image every sandbox boots from, e.g. dormice-base:20260708. */
  baseImage: string;
  /** Sparse disk images and their mount points live under this directory. */
  dataDir: string;
  /** Size cap of each sandbox disk. The limit is physical: the image file simply ends. */
  diskSizeGb: number;
  cpus: number;
  memoryGb: number;
  pidsLimit: number;
  /** How long one memory.reclaim write may take before its subprocess is killed. */
  reclaimTimeoutSeconds: number;
  log?: (msg: string) => void;
}

export function containerName(sandboxId: string): string {
  return `sbx-${sandboxId}`;
}

/**
 * Docker reports seven statuses; the executor's contract knows three. With
 * RestartPolicy "no" a container never restarts on its own, so everything
 * that is not running or paused is some flavor of "processes are dead,
 * disk remains" — exactly what the contract calls stopped.
 */
export function containerStateFromDocker(status: string): ContainerState {
  if (status === 'running') return 'running';
  if (status === 'paused') return 'paused';
  return 'stopped';
}

/** The daemon runs as root; refuse to rm anything that escaped dataDir. */
export function assertInside(base: string, target: string): void {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to touch ${target}: outside ${base}`);
  }
}

interface DockerApiError {
  statusCode: number;
}

function isDockerApiError(err: unknown): err is DockerApiError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as DockerApiError).statusCode === 'number'
  );
}

/**
 * The real executor: Docker + gVisor for isolation, one loopback-mounted
 * sparse image per sandbox for disk quota. Linux-only and needs root (mount,
 * cgroup writes); everything else in the daemon keeps running against
 * FakeExecutor, which this class must behave identically to — both pass the
 * same contract test suite, including error messages.
 */
export class DockerExecutor implements Executor {
  private readonly docker: Docker;
  private readonly opts: DockerExecutorOptions;
  private readonly log: (msg: string) => void;

  constructor(opts: DockerExecutorOptions, docker?: Docker) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    // The local socket only. Red line: this socket is the daemon's alone and
    // must never be mounted into any container.
    this.docker = docker ?? new Docker({ socketPath: '/var/run/docker.sock' });
  }

  async create(sandboxId: string): Promise<void> {
    if ((await this.inspect(sandboxId)) !== null) {
      throw new Error(`container ${sandboxId} already exists`);
    }
    await this.provisionDisk(sandboxId);
    let container: Docker.Container;
    try {
      container = await this.docker.createContainer({
        name: containerName(sandboxId),
        Image: this.opts.baseImage,
        Cmd: ['sleep', 'infinity'],
        Labels: { [SANDBOX_LABEL]: sandboxId },
        HostConfig: {
          // The security set, none optional: gVisor keeps sandbox code off
          // the real kernel, Init reaps zombies, no-new-privileges blocks
          // setuid escalation, PidsLimit stops fork bombs. The image itself
          // runs as uid 1000 (user), never root.
          Runtime: 'runsc',
          Init: true,
          SecurityOpt: ['no-new-privileges'],
          NanoCpus: Math.round(this.opts.cpus * 1e9),
          Memory: Math.round(this.opts.memoryGb * 1024 ** 3),
          PidsLimit: this.opts.pidsLimit,
          Binds: [`${this.mountDir(sandboxId)}:/home/user`],
          // Life and death belong to the daemon's state machine; Docker
          // must not resurrect anything on its own.
          RestartPolicy: { Name: 'no' },
        },
      });
    } catch (err) {
      // Name collision race between our inspect and createContainer.
      if (isDockerApiError(err) && err.statusCode === 409) {
        throw new Error(`container ${sandboxId} already exists`);
      }
      throw err;
    }
    await container.start();
  }

  async freeze(sandboxId: string): Promise<void> {
    const containerId = await this.expectState(sandboxId, 'running');
    await this.docker.getContainer(containerId).pause();
    await this.reclaimMemory(containerId);
  }

  async unfreeze(sandboxId: string): Promise<void> {
    const containerId = await this.expectState(sandboxId, 'paused');
    // Milliseconds; memory swaps back in lazily, on demand.
    await this.docker.getContainer(containerId).unpause();
  }

  async stop(sandboxId: string): Promise<void> {
    const containerId = await this.expectState(sandboxId, 'paused');
    const container = this.docker.getContainer(containerId);
    // Docker refuses to stop or kill a paused container, so unpause first.
    await container.unpause();
    // SIGKILL, no grace period: the sandbox has nothing to shut down
    // cleanly (crash-only — code must survive the container vanishing
    // anyway), and the disk's consistency is the ext4 journal's job.
    await container.kill();
    // kill only delivers the signal; Docker marks the container exited a
    // beat later. Wait for that, so the caller observes 'stopped' the
    // moment stop() resolves — the same synchronous promise the fake makes.
    await container.wait({ condition: 'not-running' });
  }

  async start(sandboxId: string): Promise<void> {
    const containerId = await this.expectState(sandboxId, 'stopped');
    // Loop mounts live in kernel memory and are gone after a host reboot,
    // while the image file and the stopped container survive on disk.
    await this.ensureMounted(sandboxId);
    await this.docker.getContainer(containerId).start();
  }

  async destroy(sandboxId: string): Promise<void> {
    const found = await this.inspect(sandboxId);
    if (found === null) {
      // The ledger says this exists and reality disagrees — a bug worth
      // hearing, same contract as the fake. Vanished containers are the
      // reconciler's case, not a silent success here.
      throw new Error(`container ${sandboxId} is absent, cannot destroy`);
    }
    const container = this.docker.getContainer(found.id);
    // Walk the container down ourselves instead of leaning on remove's
    // force-kill: dockerd cannot deliver a signal into a paused gVisor
    // sandbox and burns a hard-coded 10s wait before escalating (measured
    // 2026-07-09, sometimes erroring "PID is zombie"). Unpause so the kill
    // lands, then wait for the actual exit before removing.
    if (found.status === 'paused') {
      await container.unpause();
    }
    if (found.status === 'paused' || found.status === 'running') {
      try {
        await container.kill();
      } catch (err) {
        // Died between inspect and kill — the goal state, not a failure.
        if (!isDockerApiError(err) || err.statusCode !== 409) throw err;
      }
      await container.wait({ condition: 'not-running' });
    }
    await container.remove({ force: true });
    await this.teardownDisk(sandboxId);
  }

  async listContainers(): Promise<Map<string, ContainerState>> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [SANDBOX_LABEL] },
    });
    const observed = new Map<string, ContainerState>();
    for (const c of containers) {
      const sandboxId = c.Labels[SANDBOX_LABEL];
      if (sandboxId) {
        observed.set(sandboxId, containerStateFromDocker(c.State));
      }
    }
    return observed;
  }

  private imagePath(sandboxId: string): string {
    return path.join(this.opts.dataDir, 'disks', `${sandboxId}.img`);
  }

  private mountDir(sandboxId: string): string {
    return path.join(this.opts.dataDir, 'mnt', sandboxId);
  }

  /**
   * The sandbox disk: a sparse file (promises diskSizeGb, occupies what is
   * actually written — the physical basis of overselling) formatted as ext4
   * and loop-mounted. Benchmarked 2026-07-08: worst-case tax ≈ 0.
   */
  private async provisionDisk(sandboxId: string): Promise<void> {
    const img = this.imagePath(sandboxId);
    const mnt = this.mountDir(sandboxId);
    await mkdir(path.dirname(img), { recursive: true });
    await mkdir(mnt, { recursive: true });
    const file = await open(img, 'w');
    try {
      await file.truncate(this.opts.diskSizeGb * 1024 ** 3);
    } finally {
      await file.close();
    }
    // -F: the target is a regular file, not a block device — skip the
    // interactive "proceed anyway?" prompt no one is there to answer.
    await execa('mkfs.ext4', ['-q', '-F', img]);
    await execa('mount', ['-o', 'loop,discard', img, mnt]);
    // The mounted fs root must belong to the in-container user (uid 1000).
    await chown(mnt, 1000, 1000);
  }

  /** Idempotent: mounts the sandbox disk unless it already is mounted. */
  private async ensureMounted(sandboxId: string): Promise<void> {
    const mnt = this.mountDir(sandboxId);
    await mkdir(mnt, { recursive: true });
    const check = await execa('mountpoint', ['-q', mnt], { reject: false });
    if (check.exitCode !== 0) {
      await execa('mount', [
        '-o',
        'loop,discard',
        this.imagePath(sandboxId),
        mnt,
      ]);
    }
  }

  private async teardownDisk(sandboxId: string): Promise<void> {
    const img = this.imagePath(sandboxId);
    const mnt = this.mountDir(sandboxId);
    assertInside(this.opts.dataDir, img);
    assertInside(this.opts.dataDir, mnt);
    // Unmount may fail because nothing is mounted (e.g. after a reboot);
    // that is fine — the goal is only that rm below removes a plain dir.
    await execa('umount', [mnt], { reject: false });
    await rm(img, { force: true });
    await rm(mnt, { recursive: true, force: true });
  }

  /**
   * Looks the sandbox's container up by name. Returns the container id
   * (needed for cgroup paths, which want the full id, not the name) and
   * Docker's raw status, or null if no such container exists.
   */
  private async inspect(
    sandboxId: string,
  ): Promise<{ id: string; status: string } | null> {
    try {
      const info = await this.docker
        .getContainer(containerName(sandboxId))
        .inspect();
      return { id: info.Id, status: info.State.Status };
    } catch (err) {
      if (isDockerApiError(err) && err.statusCode === 404) return null;
      throw err;
    }
  }

  /**
   * Verifies the container is in the state the operation needs, throwing
   * the same message the fake throws — the two implementations must be
   * indistinguishable to callers, and the contract tests hold them to it.
   */
  private async expectState(
    sandboxId: string,
    wanted: ContainerState,
  ): Promise<string> {
    let actual: ContainerState | undefined;
    let containerId: string | null = null;
    try {
      const info = await this.docker
        .getContainer(containerName(sandboxId))
        .inspect();
      containerId = info.Id;
      actual = containerStateFromDocker(info.State.Status);
    } catch (err) {
      if (!isDockerApiError(err) || err.statusCode !== 404) throw err;
    }
    if (containerId === null || actual !== wanted) {
      throw new Error(
        `container ${sandboxId} is ${actual ?? 'absent'}, expected ${wanted}`,
      );
    }
    return containerId;
  }

  /**
   * Squeezes the paused container's memory out to swap — the second half of
   * freezing, what makes idle actually free.
   *
   * The number-one trap (measured 2026-07-07, kernel 6.8): writing more than
   * is actually reclaimable makes the kernel retry-scan for minutes with the
   * writer stuck unkillable. Two safety nets, both mandatory: write the
   * observed memory.current value (never a blind large number), and write
   * from a subprocess with a SIGKILL timeout — Node's own fs.writeFile would
   * wedge a thread-pool thread that nothing can kill. Hitting the timeout is
   * expected, not an error: the bulk is squeezed out within seconds and the
   * tail was never reclaimable to begin with.
   */
  private async reclaimMemory(containerId: string): Promise<void> {
    const dir = `/sys/fs/cgroup/system.slice/docker-${containerId}.scope`;
    try {
      await access(dir);
    } catch {
      this.log(`cgroup dir missing, skipping memory reclaim: ${dir}`);
      return;
    }
    const current = Number(
      (await readFile(`${dir}/memory.current`, 'utf8')).trim(),
    );
    if (!Number.isFinite(current) || current < 16 * 1024 * 1024) {
      return; // Less than 16MB is not worth squeezing.
    }
    try {
      await execa('sh', ['-c', `echo ${current} > ${dir}/memory.reclaim`], {
        timeout: this.opts.reclaimTimeoutSeconds * 1000,
        killSignal: 'SIGKILL',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`memory.reclaim cut short (expected): ${msg}`);
    }
    try {
      const after = Number(
        (await readFile(`${dir}/memory.current`, 'utf8')).trim(),
      );
      this.log(
        `reclaimed: ${(current / 1024 ** 2).toFixed(1)}MiB -> ${(after / 1024 ** 2).toFixed(1)}MiB`,
      );
    } catch {
      // Only a log line; unreadable is fine.
    }
  }
}
