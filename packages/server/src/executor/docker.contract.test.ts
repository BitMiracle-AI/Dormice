import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Docker from 'dockerode';
import { describe } from 'vitest';
import { describeExecutorContract } from './contract';
import { containerName, DockerExecutor } from './docker';

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
        diskSizeGb: 1,
        cpus: 1,
        memoryGb: 1,
        pidsLimit: 256,
        reclaimTimeoutSeconds: 45,
      });
      return {
        executor,
        // The prune analog: remove the container object straight through
        // the engine, leaving the disk behind.
        vanishContainer: async (sandboxId: string) => {
          await new Docker()
            .getContainer(containerName(sandboxId))
            .remove({ force: true });
        },
      };
    },
    // Real containers under gVisor take seconds per operation.
    { timeoutMs: 120_000 },
  );
} else {
  describe.skip('executor contract: DockerExecutor (set DORMICE_DOCKER_CONTRACT=1 and DORMICE_DOCKER_CONTRACT_IMAGE on a Linux docker host)', () => {});
}
