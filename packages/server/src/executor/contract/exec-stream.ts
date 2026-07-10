import { describe, expect, it } from 'vitest';
import type { ContractContext } from './index';

/** The streaming exec verb: live output, stdin, signals, PTY sessions. */
export function execStreamTests(ctx: ContractContext) {
  const { timeoutMs } = ctx;

  describe('execStream and PTY', () => {
    it(
      'execStream delivers output live, chunk by chunk',
      async () => {
        const id = await ctx.fresh();
        const chunks: Array<{ text: string; at: number }> = [];
        const handle = await ctx.executor.execStream(id, {
          command: 'echo first; sleep 1; echo second',
          timeoutSeconds: 30,
          onStdout: (c) => {
            chunks.push({ text: c.toString('utf8'), at: Date.now() });
          },
          onStderr: () => {},
        });
        const { exitCode } = await handle.wait();
        expect(exitCode).toBe(0);
        expect(chunks.map((c) => c.text).join('')).toBe('first\nsecond\n');
        // The anti-buffering assertion: with the sleep between the echoes,
        // live delivery shows a real gap between the first and last chunk.
        // A buffered implementation delivers everything at once — gap zero.
        const at = chunks.map((c) => c.at);
        expect(Math.max(...at) - Math.min(...at)).toBeGreaterThanOrEqual(500);
      },
      timeoutMs,
    );

    it(
      'execStream reports a nonzero exit through wait, not an error',
      async () => {
        const id = await ctx.fresh();
        const handle = await ctx.executor.execStream(id, {
          command: 'exit 7',
          timeoutSeconds: 30,
          onStdout: () => {},
          onStderr: () => {},
        });
        await expect(handle.wait()).resolves.toEqual({ exitCode: 7 });
      },
      timeoutMs,
    );

    it(
      'execStream timeout kills in-container; chunks already delivered stay delivered',
      async () => {
        const id = await ctx.fresh();
        const seen: string[] = [];
        const before = Date.now();
        const handle = await ctx.executor.execStream(id, {
          command: 'echo early; sleep 5',
          timeoutSeconds: 1,
          onStdout: (c) => {
            seen.push(c.toString('utf8'));
          },
          onStderr: () => {},
        });
        const { exitCode } = await handle.wait();
        expect(Date.now() - before).toBeLessThan(4_000);
        expect(exitCode).toBe(137);
        expect(seen.join('')).toBe('early\n');
      },
      timeoutMs,
    );

    it(
      'execStream stdin round-trips: sendStdin chunks echo back, closeStdin is EOF',
      async () => {
        const id = await ctx.fresh();
        const seen: string[] = [];
        const handle = await ctx.executor.execStream(id, {
          command: 'cat',
          timeoutSeconds: 30,
          stdin: true,
          onStdout: (c) => {
            seen.push(c.toString('utf8'));
          },
          onStderr: () => {},
        });
        await handle.sendStdin(Buffer.from('hello '));
        await handle.sendStdin(Buffer.from('world'));
        await handle.closeStdin();
        const { exitCode } = await handle.wait();
        expect(exitCode).toBe(0);
        expect(seen.join('')).toBe('hello world');
      },
      timeoutMs,
    );

    it(
      'execStream closeStdin with nothing written ends the command cleanly',
      async () => {
        const id = await ctx.fresh();
        const seen: string[] = [];
        const handle = await ctx.executor.execStream(id, {
          command: 'cat',
          timeoutSeconds: 30,
          stdin: true,
          onStdout: (c) => {
            seen.push(c.toString('utf8'));
          },
          onStderr: () => {},
        });
        await handle.closeStdin();
        const { exitCode } = await handle.wait();
        expect(exitCode).toBe(0);
        expect(seen.join('')).toBe('');
      },
      timeoutMs,
    );

    it(
      'sendStdin on a command started without stdin refuses honestly',
      async () => {
        const id = await ctx.fresh();
        const handle = await ctx.executor.execStream(id, {
          command: 'sleep 5',
          timeoutSeconds: 30,
          onStdout: () => {},
          onStderr: () => {},
        });
        await expect(handle.sendStdin(Buffer.from('x'))).rejects.toThrow(
          'process was started without stdin',
        );
        await expect(handle.closeStdin()).rejects.toThrow(
          'process was started without stdin',
        );
        await handle.signal('SIGKILL');
        await handle.wait();
      },
      timeoutMs,
    );

    it(
      'sendStdin after closeStdin refuses: stdin is closed',
      async () => {
        const id = await ctx.fresh();
        const handle = await ctx.executor.execStream(id, {
          command: 'cat',
          timeoutSeconds: 30,
          stdin: true,
          onStdout: () => {},
          onStderr: () => {},
        });
        await handle.closeStdin();
        await expect(handle.sendStdin(Buffer.from('late'))).rejects.toThrow(
          'stdin is closed',
        );
        await handle.wait();
      },
      timeoutMs,
    );

    it(
      'signal SIGKILL lands as exit 137; delivered chunks stay delivered',
      async () => {
        const id = await ctx.fresh();
        const seen: string[] = [];
        const handle = await ctx.executor.execStream(id, {
          command: 'echo early; sleep 30',
          timeoutSeconds: 60,
          onStdout: (c) => {
            seen.push(c.toString('utf8'));
          },
          onStderr: () => {},
        });
        // Wait for the first chunk so the kill provably interrupts, not races.
        const before = Date.now();
        while (seen.length === 0 && Date.now() - before < 5_000) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await handle.signal('SIGKILL');
        const { exitCode } = await handle.wait();
        expect(exitCode).toBe(137);
        expect(seen.join('')).toBe('early\n');
      },
      timeoutMs,
    );

    it(
      'signal SIGTERM lands as exit 143',
      async () => {
        const id = await ctx.fresh();
        const handle = await ctx.executor.execStream(id, {
          command: 'sleep 30',
          timeoutSeconds: 60,
          onStdout: () => {},
          onStderr: () => {},
        });
        await handle.signal('SIGTERM');
        const { exitCode } = await handle.wait();
        expect(exitCode).toBe(143);
      },
      timeoutMs,
    );

    it(
      'execStream emits nothing before it resolves',
      async () => {
        const id = await ctx.fresh();
        let resolved = false;
        let leaked = false;
        const handle = await ctx.executor.execStream(id, {
          command: 'echo eager',
          timeoutSeconds: 30,
          onStdout: () => {
            if (!resolved) leaked = true;
          },
          onStderr: () => {},
        });
        resolved = true;
        await handle.wait();
        expect(leaked).toBe(false);
      },
      timeoutMs,
    );

    it(
      'a running command survives freeze/unfreeze and completes afterwards',
      async () => {
        const id = await ctx.fresh();
        const seen: string[] = [];
        const handle = await ctx.executor.execStream(id, {
          command: 'echo started; sleep 1; echo woke',
          timeoutSeconds: 30,
          onStdout: (c) => {
            seen.push(c.toString('utf8'));
          },
          onStderr: () => {},
        });
        // Wait for proof the command is actually running before freezing:
        // dockerd acknowledges exec start before the process has spawned
        // (measured 2026-07-10 — a zero-gap pause wins that race and the
        // exec dies 128 "cannot exec in a paused state"). The contract's
        // claim is about running commands, so observe one first.
        const before = Date.now();
        while (seen.length === 0 && Date.now() - before < 5_000) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await ctx.executor.freeze(id);
        await ctx.executor.unfreeze(id);
        const { exitCode } = await handle.wait();
        expect(exitCode).toBe(0);
        expect(seen.join('')).toContain('woke');
      },
      timeoutMs,
    );

    it(
      'a PTY session echoes input and runs what is typed',
      async () => {
        const id = await ctx.fresh();
        const seen: string[] = [];
        const handle = await ctx.executor.execStream(id, {
          timeoutSeconds: 60,
          pty: { cols: 80, rows: 24 },
          env: { TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
          onStdout: (c) => {
            seen.push(c.toString('utf8'));
          },
          onStderr: () => {},
        });
        await handle.sendStdin(Buffer.from('echo pty-marker\r'));
        // contains, never equals: a real bash brings PS1 and escape codes.
        await ctx.until(() => seen.join('').includes('pty-marker'));
        await handle.sendStdin(Buffer.from('exit\r'));
        const { exitCode } = await handle.wait();
        expect(exitCode).toBe(0);
      },
      timeoutMs,
    );

    it(
      'resizePty changes what stty size reports',
      async () => {
        const id = await ctx.fresh();
        const seen: string[] = [];
        const handle = await ctx.executor.execStream(id, {
          timeoutSeconds: 60,
          pty: { cols: 80, rows: 24 },
          env: { TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
          onStdout: (c) => {
            seen.push(c.toString('utf8'));
          },
          onStderr: () => {},
        });
        await handle.resizePty({ cols: 123, rows: 45 });
        await handle.sendStdin(Buffer.from('stty size\r'));
        await ctx.until(() => seen.join('').includes('45 123'));
        await handle.sendStdin(Buffer.from('exit\r'));
        await handle.wait();
      },
      timeoutMs,
    );

    it(
      'a PTY dies to SIGKILL as 137; a plain command has no PTY to resize',
      async () => {
        const id = await ctx.fresh();
        const pty = await ctx.executor.execStream(id, {
          timeoutSeconds: 60,
          pty: { cols: 80, rows: 24 },
          env: { TERM: 'xterm-256color' },
          onStdout: () => {},
          onStderr: () => {},
        });
        await pty.signal('SIGKILL');
        expect((await pty.wait()).exitCode).toBe(137);

        const plain = await ctx.executor.execStream(id, {
          command: 'sleep 5',
          timeoutSeconds: 30,
          onStdout: () => {},
          onStderr: () => {},
        });
        await expect(plain.resizePty({ cols: 1, rows: 1 })).rejects.toThrow(
          'process has no PTY',
        );
        await plain.signal('SIGKILL');
        await plain.wait();
      },
      timeoutMs,
    );

    it(
      'stopping the sandbox settles a running command in bounded time',
      async () => {
        // The shape of the ending is not pinned — the real engine may report
        // 137 or lose the exit code entirely; settling at all is the contract
        // (a dangling wait would strand every process-table subscriber).
        const id = await ctx.fresh();
        const handle = await ctx.executor.execStream(id, {
          command: 'sleep 30',
          timeoutSeconds: 60,
          onStdout: () => {},
          onStderr: () => {},
        });
        await ctx.executor.freeze(id);
        await ctx.executor.stop(id);
        const outcome = await Promise.race([
          handle.wait().then(
            () => 'settled',
            () => 'settled',
          ),
          new Promise((resolve) =>
            setTimeout(() => resolve('hung'), timeoutMs - 1_000),
          ),
        ]);
        expect(outcome).toBe('settled');
      },
      timeoutMs,
    );
  });
}
