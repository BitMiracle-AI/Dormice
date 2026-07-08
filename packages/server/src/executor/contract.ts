import { randomUUID } from 'node:crypto';
import { EXEC_OUTPUT_LIMIT_BYTES } from '@dormice/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContainerState, Executor } from './executor';

/**
 * What a contract run needs beyond the executor itself: a way to stage the
 * one drift an executor cannot produce through its own verbs.
 */
export interface ContractSubject {
  executor: Executor;
  /**
   * Removes the container object while the disk stays — the drift a
   * `docker container prune` (or any removal behind the daemon's back)
   * leaves. The fake flips its map; the docker subject asks the engine
   * directly. Part of the contract because "start rebuilds from the disk"
   * and "destroy takes the leftover disk" must hold on both implementations.
   */
  vanishContainer(sandboxId: string): Promise<void>;
}

/**
 * The executor contract: one test suite both implementations must pass,
 * down to the error messages. Unit tests run it against FakeExecutor
 * everywhere; on a Linux docker host the same suite runs against
 * DockerExecutor — that is what makes the fake a trustworthy stand-in.
 *
 * Observations go through listContainers() and listDisks() only, because
 * together they are the whole public window into reality; sandbox ids are
 * random so runs never collide on a real machine, and everything created
 * is destroyed afterwards.
 */
export function describeExecutorContract(
  name: string,
  makeSubject: () => ContractSubject | Promise<ContractSubject>,
  { timeoutMs = 5_000 }: { timeoutMs?: number } = {},
) {
  describe(`executor contract: ${name}`, () => {
    let executor: Executor;
    let subject: ContractSubject;
    let created: string[] = [];

    beforeEach(async () => {
      subject = await makeSubject();
      executor = subject.executor;
      created = [];
    });

    afterEach(async () => {
      for (const sandboxId of created) {
        try {
          await executor.destroy(sandboxId);
        } catch {
          // Already gone — the test destroyed it itself.
        }
      }
    }, timeoutMs);

    async function fresh(): Promise<string> {
      const sandboxId = randomUUID();
      created.push(sandboxId);
      await executor.create(sandboxId);
      return sandboxId;
    }

    /** Walks a fresh sandbox down to stopped: exited container plus disk. */
    async function freshStopped(): Promise<string> {
      const sandboxId = await fresh();
      await executor.freeze(sandboxId);
      await executor.stop(sandboxId);
      return sandboxId;
    }

    async function stateOf(
      sandboxId: string,
    ): Promise<ContainerState | undefined> {
      return (await executor.listContainers()).get(sandboxId);
    }

    it(
      'walks the full container lifecycle',
      async () => {
        const id = await fresh();
        expect(await stateOf(id)).toBe('running');
        await executor.freeze(id);
        expect(await stateOf(id)).toBe('paused');
        await executor.unfreeze(id);
        expect(await stateOf(id)).toBe('running');
        await executor.freeze(id);
        await executor.stop(id);
        expect(await stateOf(id)).toBe('stopped');
        await executor.start(id);
        expect(await stateOf(id)).toBe('running');
      },
      timeoutMs,
    );

    it(
      'rejects creating the same container twice',
      async () => {
        const id = await fresh();
        await expect(executor.create(id)).rejects.toThrow(/already exists/);
      },
      timeoutMs,
    );

    it(
      'rejects operations from the wrong state',
      async () => {
        const id = await fresh();
        await expect(executor.unfreeze(id)).rejects.toThrow(/expected paused/);
        await expect(executor.stop(id)).rejects.toThrow(/expected paused/);
        await expect(executor.start(id)).rejects.toThrow(/expected stopped/);
      },
      timeoutMs,
    );

    it(
      'rejects operations on absent containers',
      async () => {
        await expect(executor.freeze(randomUUID())).rejects.toThrow(/absent/);
      },
      timeoutMs,
    );

    it(
      'destroys a container from any state',
      async () => {
        const running = await fresh();
        await executor.destroy(running);
        expect(await stateOf(running)).toBeUndefined();

        const paused = await fresh();
        await executor.freeze(paused);
        await executor.destroy(paused);
        expect(await stateOf(paused)).toBeUndefined();

        const stopped = await fresh();
        await executor.freeze(stopped);
        await executor.stop(stopped);
        await executor.destroy(stopped);
        expect(await stateOf(stopped)).toBeUndefined();
      },
      timeoutMs,
    );

    it(
      'rejects destroying an absent container',
      async () => {
        // The ledger says it exists, reality disagrees: worth hearing, not
        // a silent success — vanished containers are the reconciler's case.
        await expect(executor.destroy(randomUUID())).rejects.toThrow(/absent/);
      },
      timeoutMs,
    );

    it(
      'start rebuilds the container from a surviving disk',
      async () => {
        const id = await freshStopped();
        // The exited container object is removed behind the daemon's back —
        // exactly what a routine `docker container prune` does. The disk,
        // which is the sandbox's actual data, stays.
        await subject.vanishContainer(id);
        expect(await stateOf(id)).toBeUndefined();
        expect(await executor.listDisks()).toContain(id);

        await executor.start(id);
        expect(await stateOf(id)).toBe('running');
        expect(await executor.listDisks()).toContain(id);
      },
      timeoutMs,
    );

    it(
      'destroy of a vanished container still takes the leftover disk',
      async () => {
        const id = await freshStopped();
        await subject.vanishContainer(id);

        await executor.destroy(id);
        expect(await executor.listDisks()).not.toContain(id);
      },
      timeoutMs,
    );

    it(
      'rejects starting a sandbox that has no disk',
      async () => {
        // No container AND no disk: there is nothing to rebuild from.
        await expect(executor.start(randomUUID())).rejects.toThrow(
          /disk .+ is absent, cannot start/,
        );
      },
      timeoutMs,
    );

    it(
      'the disk lives with the container: born on create, kept through stop, gone on destroy',
      async () => {
        const id = await fresh();
        expect(await executor.listDisks()).toContain(id);
        await executor.freeze(id);
        await executor.stop(id);
        // "The processes die, the disk stays."
        expect(await executor.listDisks()).toContain(id);
        await executor.destroy(id);
        expect(await executor.listDisks()).not.toContain(id);
      },
      timeoutMs,
    );

    it(
      'removeDisk is idempotent: an absent disk already is the goal state',
      async () => {
        await expect(
          executor.removeDisk(randomUUID()),
        ).resolves.toBeUndefined();
      },
      timeoutMs,
    );

    it(
      'lists every container as an observation, not a live reference',
      async () => {
        const a = await fresh();
        const b = await fresh();
        await executor.freeze(b);

        const observed = await executor.listContainers();
        expect(observed.get(a)).toBe('running');
        expect(observed.get(b)).toBe('paused');
        // Mutating the observation must not mutate reality.
        observed.delete(a);
        expect(await stateOf(a)).toBe('running');
      },
      timeoutMs,
    );

    it(
      'exec runs a command and returns its buffered result',
      async () => {
        const id = await fresh();
        const result = await executor.exec(id, {
          command: 'echo hi',
          timeoutSeconds: 30,
        });
        expect(result).toEqual({
          exitCode: 0,
          stdout: 'hi\n',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
      timeoutMs,
    );

    it(
      'exec reports a nonzero exit code as a result, not an error',
      async () => {
        const id = await fresh();
        const result = await executor.exec(id, {
          command: 'exit 3',
          timeoutSeconds: 30,
        });
        expect(result.exitCode).toBe(3);
      },
      timeoutMs,
    );

    it(
      "exec answers an unknown command with bash's own 127",
      async () => {
        const id = await fresh();
        const result = await executor.exec(id, {
          command: 'no-such-command-xyz',
          timeoutSeconds: 30,
        });
        expect(result.exitCode).toBe(127);
        expect(result.stderr).toMatch(/command not found/);
      },
      timeoutMs,
    );

    it(
      'exec honors cwd and defaults to /home/user',
      async () => {
        const id = await fresh();
        const inTmp = await executor.exec(id, {
          command: 'pwd',
          cwd: '/tmp',
          timeoutSeconds: 30,
        });
        expect(inTmp.stdout).toBe('/tmp\n');
        const inHome = await executor.exec(id, {
          command: 'pwd',
          timeoutSeconds: 30,
        });
        expect(inHome.stdout).toBe('/home/user\n');
      },
      timeoutMs,
    );

    it(
      'exec passes env vars through',
      async () => {
        const id = await fresh();
        const result = await executor.exec(id, {
          command: 'printenv DORMICE_CONTRACT_PROBE',
          env: { DORMICE_CONTRACT_PROBE: '42' },
          timeoutSeconds: 30,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('42\n');
      },
      timeoutMs,
    );

    it(
      'rejects exec on a container that is not running',
      async () => {
        const paused = await fresh();
        await executor.freeze(paused);
        await expect(
          executor.exec(paused, { command: 'echo hi', timeoutSeconds: 30 }),
        ).rejects.toThrow(/is paused, expected running/);

        const stopped = await freshStopped();
        await expect(
          executor.exec(stopped, { command: 'echo hi', timeoutSeconds: 30 }),
        ).rejects.toThrow(/is stopped, expected running/);

        await expect(
          executor.exec(randomUUID(), {
            command: 'echo hi',
            timeoutSeconds: 30,
          }),
        ).rejects.toThrow(/is absent, expected running/);
      },
      timeoutMs,
    );

    it(
      'the timeout kills the command in-container: exit 137',
      async () => {
        const id = await fresh();
        const before = Date.now();
        const result = await executor.exec(id, {
          command: 'sleep 5',
          timeoutSeconds: 1,
        });
        // Well under the 5s sleep proves the kill actually landed; the
        // slack above 1s absorbs a loaded docker host.
        expect(Date.now() - before).toBeLessThan(4_000);
        expect(result.exitCode).toBe(137);
      },
      timeoutMs,
    );

    it(
      'exec caps each stream and reports the truncation',
      async () => {
        const id = await fresh();
        // seq, not a giant echo literal: MAX_ARG_STRLEN caps one argv
        // element at 128 KiB, so an over-cap echo argument would die in
        // execve on the real executor instead of testing the cap.
        const result = await executor.exec(id, {
          command: 'seq 1 300000',
          timeoutSeconds: 60,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdoutTruncated).toBe(true);
        expect(result.stdout.length).toBe(EXEC_OUTPUT_LIMIT_BYTES);
        expect(result.stderrTruncated).toBe(false);
      },
      timeoutMs,
    );
  });
}
