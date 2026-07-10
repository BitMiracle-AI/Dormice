import { randomUUID } from 'node:crypto';
import { EXEC_OUTPUT_LIMIT_BYTES } from '@dormice/shared';
import { describe, expect, it } from 'vitest';
import type { ContractContext } from './index';

/** The buffered exec verb: run to completion, one result object back. */
export function execTests(ctx: ContractContext) {
  const { timeoutMs } = ctx;

  describe('exec', () => {
    it(
      'exec runs a command and returns its buffered result',
      async () => {
        const id = await ctx.fresh();
        const result = await ctx.executor.exec(id, {
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
        const id = await ctx.fresh();
        const result = await ctx.executor.exec(id, {
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
        const id = await ctx.fresh();
        const result = await ctx.executor.exec(id, {
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
        const id = await ctx.fresh();
        const inTmp = await ctx.executor.exec(id, {
          command: 'pwd',
          cwd: '/tmp',
          timeoutSeconds: 30,
        });
        expect(inTmp.stdout).toBe('/tmp\n');
        const inHome = await ctx.executor.exec(id, {
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
        const id = await ctx.fresh();
        const result = await ctx.executor.exec(id, {
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
        const paused = await ctx.fresh();
        await ctx.executor.freeze(paused);
        await expect(
          ctx.executor.exec(paused, { command: 'echo hi', timeoutSeconds: 30 }),
        ).rejects.toThrow(/is paused, expected running/);

        const stopped = await ctx.freshStopped();
        await expect(
          ctx.executor.exec(stopped, {
            command: 'echo hi',
            timeoutSeconds: 30,
          }),
        ).rejects.toThrow(/is stopped, expected running/);

        await expect(
          ctx.executor.exec(randomUUID(), {
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
        const id = await ctx.fresh();
        const before = Date.now();
        const result = await ctx.executor.exec(id, {
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
        const id = await ctx.fresh();
        // seq, not a giant echo literal: MAX_ARG_STRLEN caps one argv
        // element at 128 KiB, so an over-cap echo argument would die in
        // execve on the real executor instead of testing the cap.
        const result = await ctx.executor.exec(id, {
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
