import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Docker from 'dockerode';
import { afterAll, describe } from 'vitest';
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
        pidsLimit: 256,
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
