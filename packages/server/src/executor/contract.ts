import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  EXEC_OUTPUT_LIMIT_BYTES,
  FILE_SIZE_LIMIT_BYTES,
} from '@dormice/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ContainerState,
  type Executor,
  FileNotFoundError,
  FileTooLargeError,
  NotADirectoryError,
  NotAFileError,
} from './executor';

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

    it(
      'execStream delivers output live, chunk by chunk',
      async () => {
        const id = await fresh();
        const chunks: Array<{ text: string; at: number }> = [];
        const handle = await executor.execStream(id, {
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
        const id = await fresh();
        const handle = await executor.execStream(id, {
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
        const id = await fresh();
        const seen: string[] = [];
        const before = Date.now();
        const handle = await executor.execStream(id, {
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
        const id = await fresh();
        const seen: string[] = [];
        const handle = await executor.execStream(id, {
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
        const id = await fresh();
        const seen: string[] = [];
        const handle = await executor.execStream(id, {
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
        const id = await fresh();
        const handle = await executor.execStream(id, {
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
        const id = await fresh();
        const handle = await executor.execStream(id, {
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
        const id = await fresh();
        const seen: string[] = [];
        const handle = await executor.execStream(id, {
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
        const id = await fresh();
        const handle = await executor.execStream(id, {
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
        const id = await fresh();
        let resolved = false;
        let leaked = false;
        const handle = await executor.execStream(id, {
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
      'a command survives freeze/unfreeze and completes afterwards',
      async () => {
        const id = await fresh();
        const seen: string[] = [];
        const handle = await executor.execStream(id, {
          command: 'sleep 1; echo woke',
          timeoutSeconds: 30,
          onStdout: (c) => {
            seen.push(c.toString('utf8'));
          },
          onStderr: () => {},
        });
        await executor.freeze(id);
        await executor.unfreeze(id);
        const { exitCode } = await handle.wait();
        expect(exitCode).toBe(0);
        expect(seen.join('')).toContain('woke');
      },
      timeoutMs,
    );

    /** Polls until the observation holds — PTY output has no fixed schedule. */
    async function until(check: () => boolean): Promise<void> {
      const before = Date.now();
      while (!check()) {
        if (Date.now() - before > timeoutMs - 1_000) {
          throw new Error('condition never became true');
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    it(
      'a PTY session echoes input and runs what is typed',
      async () => {
        const id = await fresh();
        const seen: string[] = [];
        const handle = await executor.execStream(id, {
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
        await until(() => seen.join('').includes('pty-marker'));
        await handle.sendStdin(Buffer.from('exit\r'));
        const { exitCode } = await handle.wait();
        expect(exitCode).toBe(0);
      },
      timeoutMs,
    );

    it(
      'resizePty changes what stty size reports',
      async () => {
        const id = await fresh();
        const seen: string[] = [];
        const handle = await executor.execStream(id, {
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
        await until(() => seen.join('').includes('45 123'));
        await handle.sendStdin(Buffer.from('exit\r'));
        await handle.wait();
      },
      timeoutMs,
    );

    it(
      'a PTY dies to SIGKILL as 137; a plain command has no PTY to resize',
      async () => {
        const id = await fresh();
        const pty = await executor.execStream(id, {
          timeoutSeconds: 60,
          pty: { cols: 80, rows: 24 },
          env: { TERM: 'xterm-256color' },
          onStdout: () => {},
          onStderr: () => {},
        });
        await pty.signal('SIGKILL');
        expect((await pty.wait()).exitCode).toBe(137);

        const plain = await executor.execStream(id, {
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
        const id = await fresh();
        const handle = await executor.execStream(id, {
          command: 'sleep 30',
          timeoutSeconds: 60,
          onStdout: () => {},
          onStderr: () => {},
        });
        await executor.freeze(id);
        await executor.stop(id);
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

    it(
      'writeFiles then readFile round-trips text',
      async () => {
        const id = await fresh();
        await executor.writeFiles(id, [
          { path: '/home/user/hello.txt', content: Buffer.from('hello\n') },
        ]);
        const read = await executor.readFile(id, '/home/user/hello.txt');
        expect(read.toString('utf8')).toBe('hello\n');
      },
      timeoutMs,
    );

    it(
      'file content round-trips byte-exact, binary included',
      async () => {
        const id = await fresh();
        // Every byte value, repeated — any encoding sloppiness (utf8 coercion,
        // base64 mangling, CR/LF translation) breaks the exact comparison.
        const bytes = Buffer.alloc(256 * 64);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
        await executor.writeFiles(id, [
          { path: '/home/user/blob.bin', content: bytes },
        ]);
        const read = await executor.readFile(id, '/home/user/blob.bin');
        expect(read.equals(bytes)).toBe(true);
      },
      timeoutMs,
    );

    it(
      'writeFiles writes the whole batch',
      async () => {
        const id = await fresh();
        await executor.writeFiles(id, [
          { path: '/home/user/a.txt', content: Buffer.from('a') },
          { path: '/home/user/b.txt', content: Buffer.from('b') },
          { path: '/home/user/c.txt', content: Buffer.from('c') },
        ]);
        expect(
          (await executor.readFile(id, '/home/user/a.txt')).toString(),
        ).toBe('a');
        expect(
          (await executor.readFile(id, '/home/user/b.txt')).toString(),
        ).toBe('b');
        expect(
          (await executor.readFile(id, '/home/user/c.txt')).toString(),
        ).toBe('c');
      },
      timeoutMs,
    );

    it(
      'relative paths resolve against /home/user',
      async () => {
        const id = await fresh();
        await executor.writeFiles(id, [
          { path: 'rel.txt', content: Buffer.from('via relative') },
        ]);
        const read = await executor.readFile(id, '/home/user/rel.txt');
        expect(read.toString('utf8')).toBe('via relative');
      },
      timeoutMs,
    );

    it(
      'writeFiles creates missing parent directories',
      async () => {
        const id = await fresh();
        await executor.writeFiles(id, [
          {
            path: '/home/user/deep/er/nested.txt',
            content: Buffer.from('deep'),
          },
        ]);
        const read = await executor.readFile(
          id,
          '/home/user/deep/er/nested.txt',
        );
        expect(read.toString('utf8')).toBe('deep');
      },
      timeoutMs,
    );

    it(
      'writing an existing path overwrites it',
      async () => {
        const id = await fresh();
        await executor.writeFiles(id, [
          { path: '/home/user/v.txt', content: Buffer.from('first') },
        ]);
        await executor.writeFiles(id, [
          { path: '/home/user/v.txt', content: Buffer.from('second') },
        ]);
        const read = await executor.readFile(id, '/home/user/v.txt');
        expect(read.toString('utf8')).toBe('second');
      },
      timeoutMs,
    );

    it(
      'files live on the disk: they survive stop, start, even a vanished container',
      async () => {
        const id = await fresh();
        await executor.writeFiles(id, [
          { path: '/home/user/keep.txt', content: Buffer.from('still here') },
        ]);
        await executor.freeze(id);
        await executor.stop(id);
        // The container object itself is lost (a prune) — the disk, which
        // holds the files, is the sandbox's actual body.
        await subject.vanishContainer(id);
        await executor.start(id);
        const read = await executor.readFile(id, '/home/user/keep.txt');
        expect(read.toString('utf8')).toBe('still here');
      },
      timeoutMs,
    );

    it(
      'readFile on a missing path throws FileNotFoundError',
      async () => {
        const id = await fresh();
        const missing = '/home/user/absent.txt';
        const error = await executor.readFile(id, missing).catch((e) => e);
        expect(error).toBeInstanceOf(FileNotFoundError);
        expect(error.message).toBe(`no such file: ${missing}`);
      },
      timeoutMs,
    );

    it(
      'readFile on a directory throws NotAFileError',
      async () => {
        const id = await fresh();
        // /home/user exists as a directory in every sandbox by construction.
        const error = await executor.readFile(id, '/home/user').catch((e) => e);
        expect(error).toBeInstanceOf(NotAFileError);
        expect(error.message).toBe('not a regular file: /home/user');
      },
      timeoutMs,
    );

    it(
      'writeFiles onto a directory throws NotAFileError',
      async () => {
        const id = await fresh();
        const error = await executor
          .writeFiles(id, [{ path: '/home/user', content: Buffer.from('x') }])
          .catch((e) => e);
        expect(error).toBeInstanceOf(NotAFileError);
        expect(error.message).toBe('not a regular file: /home/user');
      },
      timeoutMs,
    );

    it(
      'readFile refuses an over-limit file with its actual size, never truncates',
      async () => {
        const id = await fresh();
        // One byte over the line. The executor's write path is deliberately
        // uncapped (the protocol schema is the write-cap adjudicator), which
        // is exactly what lets the exam stage an over-limit file to read.
        const size = FILE_SIZE_LIMIT_BYTES + 1;
        await executor.writeFiles(id, [
          { path: '/home/user/big.bin', content: Buffer.alloc(size) },
        ]);
        const error = await executor
          .readFile(id, '/home/user/big.bin')
          .catch((e) => e);
        expect(error).toBeInstanceOf(FileTooLargeError);
        expect(error.message).toBe(
          `file too large: /home/user/big.bin is ${size} bytes, limit ${FILE_SIZE_LIMIT_BYTES}`,
        );
      },
      timeoutMs * 4,
    );

    it(
      'rejects file operations on a container that is not running',
      async () => {
        const paused = await fresh();
        await executor.freeze(paused);
        await expect(
          executor.writeFiles(paused, [
            { path: 'x.txt', content: Buffer.from('x') },
          ]),
        ).rejects.toThrow(/is paused, expected running/);
        await expect(executor.readFile(paused, 'x.txt')).rejects.toThrow(
          /is paused, expected running/,
        );

        await expect(executor.readFile(randomUUID(), 'x.txt')).rejects.toThrow(
          /is absent, expected running/,
        );
      },
      timeoutMs,
    );

    it(
      'statEntry reports a file with its real metadata',
      async () => {
        const id = await fresh();
        await executor.writeFiles(id, [
          { path: '/home/user/s.txt', content: Buffer.from('12345') },
        ]);
        // Relative path resolves like every other file verb.
        const entry = await executor.statEntry(id, 's.txt');
        expect(entry).toMatchObject({
          name: 's.txt',
          path: '/home/user/s.txt',
          type: 'file',
          sizeBytes: 5,
          mode: 0o644,
          owner: 'user',
          group: 'user',
        });
        // Written moments ago; both executors report a live clock.
        expect(
          Math.abs(Date.parse(entry.modifiedTime) - Date.now()),
        ).toBeLessThan(60_000);
      },
      timeoutMs,
    );

    it(
      'statEntry reports directories and refuses missing paths',
      async () => {
        const id = await fresh();
        const home = await executor.statEntry(id, '/home/user');
        expect(home).toMatchObject({
          name: 'user',
          path: '/home/user',
          type: 'dir',
          mode: 0o755,
          owner: 'user',
        });

        const missing = '/home/user/nope';
        const error = await executor.statEntry(id, missing).catch((e) => e);
        expect(error).toBeInstanceOf(FileNotFoundError);
        expect(error.message).toBe(`no such file: ${missing}`);
      },
      timeoutMs,
    );

    it(
      'listDir walks exactly as deep as asked, sorted by path',
      async () => {
        const id = await fresh();
        await executor.writeFiles(id, [
          { path: '/home/user/a.txt', content: Buffer.from('a') },
          { path: '/home/user/sub/b.txt', content: Buffer.from('b') },
        ]);
        // Depth 1: the file, the created dir — and lost+found, the mkfs
        // artifact every real disk root carries; the listing shows reality.
        const one = await executor.listDir(id, '/home/user', 1);
        expect(one.map((e) => [e.path, e.type])).toEqual([
          ['/home/user/a.txt', 'file'],
          ['/home/user/lost+found', 'dir'],
          ['/home/user/sub', 'dir'],
        ]);
        const two = await executor.listDir(id, '/home/user', 2);
        expect(two.map((e) => e.path)).toEqual([
          '/home/user/a.txt',
          '/home/user/lost+found',
          '/home/user/sub',
          '/home/user/sub/b.txt',
        ]);
      },
      timeoutMs,
    );

    it(
      'listDir refuses files and missing paths with the right errors',
      async () => {
        const id = await fresh();
        await executor.writeFiles(id, [
          { path: '/home/user/plain.txt', content: Buffer.from('x') },
        ]);
        const onFile = await executor
          .listDir(id, '/home/user/plain.txt', 1)
          .catch((e) => e);
        expect(onFile).toBeInstanceOf(NotADirectoryError);
        expect(onFile.message).toBe('not a directory: /home/user/plain.txt');

        const onMissing = await executor
          .listDir(id, '/home/user/void', 1)
          .catch((e) => e);
        expect(onMissing).toBeInstanceOf(FileNotFoundError);
        expect(onMissing.message).toBe('no such file: /home/user/void');
      },
      timeoutMs,
    );

    it(
      'makeDir creates with parents, and reports "already there" as false',
      async () => {
        const id = await fresh();
        expect(await executor.makeDir(id, '/home/user/mk/deep')).toBe(true);
        expect(
          await executor.statEntry(id, '/home/user/mk/deep'),
        ).toMatchObject({ type: 'dir', owner: 'user' });
        // Again: already exists — false, not an error, whatever is there.
        expect(await executor.makeDir(id, '/home/user/mk/deep')).toBe(false);
        await executor.writeFiles(id, [
          { path: '/home/user/mk/file.txt', content: Buffer.from('f') },
        ]);
        expect(await executor.makeDir(id, '/home/user/mk/file.txt')).toBe(
          false,
        );
      },
      timeoutMs,
    );

    it(
      'move renames a file and refuses a missing source',
      async () => {
        const id = await fresh();
        await executor.writeFiles(id, [
          { path: '/home/user/m1.txt', content: Buffer.from('payload') },
        ]);
        const moved = await executor.move(
          id,
          '/home/user/m1.txt',
          '/home/user/m2.txt',
        );
        expect(moved).toMatchObject({
          path: '/home/user/m2.txt',
          type: 'file',
          sizeBytes: 7,
        });
        const gone = await executor
          .readFile(id, '/home/user/m1.txt')
          .catch((e) => e);
        expect(gone).toBeInstanceOf(FileNotFoundError);
        expect(
          (await executor.readFile(id, '/home/user/m2.txt')).toString(),
        ).toBe('payload');

        const missing = await executor
          .move(id, '/home/user/void.txt', '/home/user/x.txt')
          .catch((e) => e);
        expect(missing).toBeInstanceOf(FileNotFoundError);
        expect(missing.message).toBe('no such file: /home/user/void.txt');
      },
      timeoutMs,
    );

    it(
      'remove takes a file, takes a tree, refuses what is not there',
      async () => {
        const id = await fresh();
        await executor.writeFiles(id, [
          { path: '/home/user/r/a.txt', content: Buffer.from('a') },
          { path: '/home/user/r/sub/b.txt', content: Buffer.from('b') },
          { path: '/home/user/single.txt', content: Buffer.from('s') },
        ]);
        await executor.remove(id, '/home/user/single.txt');
        await executor.remove(id, '/home/user/r');
        const statR = await executor
          .statEntry(id, '/home/user/r')
          .catch((e) => e);
        expect(statR).toBeInstanceOf(FileNotFoundError);

        const again = await executor.remove(id, '/home/user/r').catch((e) => e);
        expect(again).toBeInstanceOf(FileNotFoundError);
        expect(again.message).toBe('no such file: /home/user/r');
      },
      timeoutMs,
    );

    it(
      'the streaming file path is the uncapped one: over-limit content round-trips byte-exact',
      async () => {
        const id = await fresh();
        // Past the buffered API's 16 MiB line — only the stream may carry it.
        const size = FILE_SIZE_LIMIT_BYTES + 5;
        const big = Buffer.alloc(size);
        for (let i = 0; i < size; i += 4096) big[i] = i % 251;
        const half = Math.floor(size / 2);
        await executor.writeFileStream(
          id,
          '/home/user/big-stream.bin',
          Readable.from([big.subarray(0, half), big.subarray(half)]),
        );
        const chunks: Buffer[] = [];
        await executor.readFileStream(id, '/home/user/big-stream.bin', (c) => {
          chunks.push(Buffer.from(c));
        });
        expect(Buffer.concat(chunks).equals(big)).toBe(true);
        // The buffered read still refuses it: two paths, two contracts.
        await expect(
          executor.readFile(id, '/home/user/big-stream.bin'),
        ).rejects.toThrow(FileTooLargeError);
      },
      timeoutMs * 4,
    );

    it(
      'streaming file verbs throw the same typed errors as the buffered ones',
      async () => {
        const id = await fresh();
        const missing = await executor
          .readFileStream(id, '/home/user/void.bin', () => {})
          .catch((e) => e);
        expect(missing).toBeInstanceOf(FileNotFoundError);
        expect(missing.message).toBe('no such file: /home/user/void.bin');

        const onDir = await executor
          .readFileStream(id, '/home/user', () => {})
          .catch((e) => e);
        expect(onDir).toBeInstanceOf(NotAFileError);
        expect(onDir.message).toBe('not a regular file: /home/user');

        const writeDir = await executor
          .writeFileStream(id, '/home/user', Readable.from([Buffer.from('x')]))
          .catch((e) => e);
        expect(writeDir).toBeInstanceOf(NotAFileError);
        expect(writeDir.message).toBe('not a regular file: /home/user');
      },
      timeoutMs,
    );
  });
}
