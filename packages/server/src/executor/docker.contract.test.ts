import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Docker from 'dockerode';
import { afterAll, describe, expect, it } from 'vitest';
import { describeExecutorContract } from './contract';
import { containerName, DockerExecutor } from './docker';

/**
 * The exam's second image name: the base image tagged under an alias.
 * Physically identical to the base — the image chapter asks which *name*
 * a shell records, not what is inside.
 */
const ALT_IMAGE = 'dormice-contract-alt:latest';

/**
 * The real-machine half of the executor contract. Needs a Linux host with
 * Docker + gVisor, the base image built, and root (loop mounts, cgroups) —
 * so it only runs when explicitly armed:
 *
 *   DORMICE_DOCKER_CONTRACT=1 DORMICE_DOCKER_CONTRACT_IMAGE=dormice-base:<date> \
 *     pnpm --filter @dormice/server test docker.contract
 *
 * Everywhere else (Mac dev, CI without gVisor) it reports itself as skipped
 * instead of failing or silently passing.
 */
const image = process.env.DORMICE_DOCKER_CONTRACT_IMAGE;

if (process.env.DORMICE_DOCKER_CONTRACT === '1' && image) {
  describeExecutorContract(
    'DockerExecutor',
    async () => {
      const dataDir = await mkdtemp(path.join(tmpdir(), 'dormice-contract-'));
      const executor = new DockerExecutor({
        baseImage: image,
        dataDir,
        // Small and fast: the contract exercises lifecycle, not capacity.
        // A static closure, not a ledger read: the contract exam runs the
        // executor bare, without a daemon or its settings row.
        resources: () => ({ diskSizeGb: 1, cpus: 1, memoryGb: 1 }),
        pidsLimit: () => 256,
        reclaimTimeoutSeconds: 45,
      });
      // Idempotent: re-tagging the same target is a no-op, and the tag is
      // removed once after the whole file (afterAll below).
      await new Docker()
        .getImage(image)
        .tag({ repo: 'dormice-contract-alt', tag: 'latest' });
      return {
        executor,
        // The prune analog: remove the container object straight through
        // the engine, leaving the disk behind.
        vanishContainer: async (sandboxId: string) => {
          await new Docker()
            .getContainer(containerName(sandboxId))
            .remove({ force: true });
        },
        baseImage: image,
        altImage: ALT_IMAGE,
        imageOf: async (sandboxId: string) => {
          const info = await new Docker()
            .getContainer(containerName(sandboxId))
            .inspect();
          return info.Config.Image;
        },
      };
    },
    // Real containers under gVisor take seconds per operation.
    { timeoutMs: 120_000 },
  );

  /**
   * Docker-only: the pids cap is a host-side cgroup value; the fake models
   * the number but not the physics. Several executors over one data dir
   * play "the operator changed pidsLimit in settings" (a live read in
   * production; closures here); the container stays the same object
   * throughout — the point is that no rebuild happens.
   */
  describe('DockerExecutor: an existing shell follows the configured pids cap', () => {
    it('the sweep verb moves a running shell in place; unpause and start bring HostConfig and the live cgroup to the cap', async () => {
      const dataDir = await mkdtemp(path.join(tmpdir(), 'dormice-contract-'));
      const withCap = (pidsLimit: number) =>
        new DockerExecutor({
          baseImage: image,
          dataDir,
          resources: () => ({ diskSizeGb: 1, cpus: 1, memoryGb: 1 }),
          pidsLimit: () => pidsLimit,
          reclaimTimeoutSeconds: 45,
        });
      const id = randomUUID();
      const container = () => new Docker().getContainer(containerName(id));
      const hostConfigCap = async () =>
        (await container().inspect()).HostConfig.PidsLimit;
      const cgroupCap = async () => {
        const info = await container().inspect();
        return (
          await readFile(
            `/sys/fs/cgroup/system.slice/docker-${info.Id}.scope/pids.max`,
            'utf8',
          )
        ).trim();
      };
      const born = withCap(256);
      try {
        await born.create(id);
        expect(await hostConfigCap()).toBe(256);
        expect(await cgroupCap()).toBe('256');

        // The sweep's verb: a running shell moves in place — same
        // container, its processes untouched — and a second pass finds
        // the cap in force.
        expect(await withCap(4096).convergePidsLimit(id)).toBe('updated');
        expect(await hostConfigCap()).toBe(4096);
        expect(await cgroupCap()).toBe('4096');
        expect(await withCap(4096).convergePidsLimit(id)).toBe('in-force');
        // The update names the pids cap alone. Docker re-sends the shell's
        // stored CPU and memory limits to the runtime alongside it — the
        // same numbers it was born with, so a pids move is never a
        // resource change in disguise.
        const resources = (await container().inspect()).HostConfig;
        expect(resources.NanoCpus).toBe(1e9);
        expect(resources.Memory).toBe(1024 ** 3);

        // Paused: runsc refuses the update, so the verb does not try; the
        // wake converges instead — still a plain unpause of the same
        // container, processes alive.
        await born.freeze(id);
        expect(await withCap(512).convergePidsLimit(id)).toBe('skipped');
        expect(await hostConfigCap()).toBe(4096);
        await withCap(512).unfreeze(id);
        expect(await hostConfigCap()).toBe(512);
        expect(await cgroupCap()).toBe('512');

        // A stopped shell: the verb leaves it alone, the update lands
        // before start, and the started container runs under the new cap.
        const lowered = withCap(1024);
        await lowered.freeze(id);
        await lowered.stop(id);
        expect(await lowered.convergePidsLimit(id)).toBe('skipped');
        await lowered.start(id);
        expect(await hostConfigCap()).toBe(1024);
        expect(await cgroupCap()).toBe('1024');
      } finally {
        await withCap(1024).destroy(id);
        await rm(dataDir, { recursive: true, force: true });
      }
    }, 120_000);
  });

  /**
   * Docker-only: the lag between a sandbox's death and Docker recording
   * it. The fake's deaths are instantaneous; only a real runtime shows
   * the 100-300ms in which State.Status still says running while the
   * sentry is a zombie (and, for an OOM, State.OOMKilled is already set).
   * A consumer learns of the death from its own exec stream's EOF and
   * asks at once — exitOf must answer with the death, not null. Both
   * signatures the fleet has actually died of: the memory cgroup, and the
   * pids cap refusing the sentry a thread.
   */
  describe('DockerExecutor: exitOf sees a death before Docker has marked the shell exited', () => {
    const dyingShell = async (memoryGb: number) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), 'dormice-contract-'));
      const executor = new DockerExecutor({
        baseImage: image,
        dataDir,
        resources: () => ({ diskSizeGb: 1, cpus: 1, memoryGb }),
        pidsLimit: () => 256,
        reclaimTimeoutSeconds: 45,
      });
      const id = randomUUID();
      await executor.create(id);
      return {
        executor,
        id,
        // The killer's exec ends with the sandbox; however it surfaces, the
        // question is what exitOf says the instant afterwards.
        die: (command: string) =>
          executor
            .exec(id, { command, timeoutSeconds: 60 })
            .catch(() => undefined),
        cleanup: async () => {
          await executor.destroy(id);
          await rm(dataDir, { recursive: true, force: true });
        },
      };
    };

    it('a memory-cgroup OOM kill reads as oom-killed the instant the exec stream ends', async () => {
      const shell = await dyingShell(0.5);
      try {
        await shell.die(
          "node -e 'const a=[];for(;;){const b=Buffer.allocUnsafe(64<<20);b.fill(1);a.push(b);}'",
        );
        const exit = await shell.executor.exitOf(shell.id);
        expect(exit).toMatchObject({
          exitCode: 137,
          oomKilled: true,
          runtimeDied: false,
        });
      } finally {
        await shell.cleanup();
      }
    }, 120_000);

    it('a pids-cap hit reads as runtime-died the instant the exec stream ends', async () => {
      const shell = await dyingShell(1);
      try {
        // Lowered behind the executor's back, as an operator's `docker
        // update` would: 64 is below the sentry's own thread budget.
        await new Docker()
          .getContainer(containerName(shell.id))
          .update({ PidsLimit: 64 });
        await shell.die('for i in $(seq 1 200); do sleep 300 & done; wait');
        const exit = await shell.executor.exitOf(shell.id);
        expect(exit).toMatchObject({
          exitCode: 2,
          oomKilled: false,
          runtimeDied: true,
        });
      } finally {
        await shell.cleanup();
      }
    }, 120_000);
  });

  afterAll(async () => {
    try {
      await new Docker().getImage(ALT_IMAGE).remove();
    } catch {
      // Never tagged (suite failed before makeSubject) — nothing to clean.
    }
  });
} else {
  describe.skip('executor contract: DockerExecutor (set DORMICE_DOCKER_CONTRACT=1 and DORMICE_DOCKER_CONTRACT_IMAGE on a Linux docker host)', () => {});
}
