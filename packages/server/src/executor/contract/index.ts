import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe } from 'vitest';
import type { ContainerState, Executor } from '../executor';
import { entryTests } from './entries';
import { execTests } from './exec';
import { execStreamTests } from './exec-stream';
import { fileTests } from './files';
import { lifecycleTests } from './lifecycle';
import { watchTests } from './watch';

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
 * The exam harness each section receives: live views of the subject under
 * test (rebuilt per test by beforeEach — hence getters, not snapshots) and
 * the helpers every section leans on.
 */
export interface ContractContext {
  readonly executor: Executor;
  readonly subject: ContractSubject;
  timeoutMs: number;
  /** A fresh running sandbox, registered for after-test destruction. */
  fresh(): Promise<string>;
  /** Walks a fresh sandbox down to stopped: exited container plus disk. */
  freshStopped(): Promise<string>;
  stateOf(sandboxId: string): Promise<ContainerState | undefined>;
  /** Polls until the observation holds — real output has no fixed schedule. */
  until(check: () => boolean): Promise<void>;
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
 *
 * One exam, one entry point: the sections under ./contract/ are chapters
 * of this suite, never run on their own.
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

    const ctx: ContractContext = {
      get executor() {
        return executor;
      },
      get subject() {
        return subject;
      },
      timeoutMs,
      async fresh() {
        const sandboxId = randomUUID();
        created.push(sandboxId);
        await executor.create(sandboxId);
        return sandboxId;
      },
      async freshStopped() {
        const sandboxId = await ctx.fresh();
        await executor.freeze(sandboxId);
        await executor.stop(sandboxId);
        return sandboxId;
      },
      async stateOf(sandboxId) {
        return (await executor.listContainers()).get(sandboxId);
      },
      async until(check) {
        const before = Date.now();
        while (!check()) {
          if (Date.now() - before > timeoutMs - 1_000) {
            throw new Error('condition never became true');
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      },
    };

    lifecycleTests(ctx);
    execTests(ctx);
    execStreamTests(ctx);
    fileTests(ctx);
    entryTests(ctx);
    watchTests(ctx);
  });
}
