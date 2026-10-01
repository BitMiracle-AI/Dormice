import { PassThrough } from 'node:stream';
import { EXEC_END_GRACE_SECONDS } from '@dormice/shared';
import type Docker from 'dockerode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXEC_END_SILENCE_SECONDS, VERB_DEADLINE_SECONDS } from './deadline';
import { DockerExecutor, rootfsBytesOf } from './docker';
import { FILE_OP_TIMEOUT_SECONDS } from './docker-scripts';
import { END_PROBE_MS } from './docker-streams';

/**
 * The exec pipeline against a dockerd that loses an exec's end — the shape
 * moby #53614 leaves a container in once an exec's output goes unread: the
 * process has exited in the container, but its stream never closes and the
 * engine keeps it Running forever (Beijing, 2026-09-28: a MakeDir held its
 * sandbox's slot for 36 hours). The stub answers container inspect as a
 * running box and hands out execs whose behavior each test sets; the clock
 * is faked, so the bound is met without waiting it out.
 */

/** One exec as the stub hands it out: its stream and what inspect says. */
interface StubExec {
  cmd: string[];
  stream: PassThrough;
  info: { Running: boolean; ExitCode: number | null; Pid: number };
  /**
   * dockerd cannot answer an inspect of this exec — its handling of the
   * exit holds the exec's lock while the exec's output waits to be read.
   */
  hangs: boolean;
}

/**
 * `start` settles one exec start: the stream by default, or never (a lost
 * answer), or later (a late one) when the test takes the promise over.
 */
function stubDocker(
  start: (exec: StubExec) => Promise<PassThrough> = async (exec) => exec.stream,
) {
  const execs: StubExec[] = [];
  const docker = {
    getContainer() {
      return {
        async inspect() {
          return {
            Id: 'c0ffee',
            State: {
              Status: 'running',
              OOMKilled: false,
              ExitCode: 0,
              Pid: process.pid,
              FinishedAt: '0001-01-01T00:00:00Z',
            },
            HostConfig: { NanoCpus: 1e9, PidsLimit: 4096 },
          };
        },
        async exec(opts: { Cmd: string[] }) {
          const exec: StubExec = {
            cmd: opts.Cmd,
            stream: new PassThrough(),
            // A pid no host process has: on Linux /proc says gone, so a
            // process dockerd still calls running has ended (off Linux
            // hostProcessAlive answers "alive" — covered below). A test of
            // a process that runs on names a live pid, or none (0).
            info: { Running: true, ExitCode: null, Pid: 2 ** 22 + 1 },
            hangs: false,
          };
          execs.push(exec);
          return {
            id: `exec-${execs.length}`,
            start: () => start(exec),
            inspect: () =>
              exec.hangs
                ? new Promise<never>(() => {})
                : Promise.resolve(exec.info),
            resize: async () => {},
          };
        },
      };
    },
  };
  return { docker: docker as unknown as Docker, execs };
}

function executor(docker: Docker, log: (msg: string) => void = () => {}) {
  return new DockerExecutor(
    {
      baseImage: () => 'unused',
      registry: { address: () => null, username: 'dormice', password: 'x' },
      dataDir: '/nonexistent',
      resources: () => ({ diskSizeGb: 1, cpus: 1, memoryGb: 1 }),
      pidsLimit: () => 4096,
      reclaimTimeoutSeconds: 1,
      log,
    },
    docker,
  );
}

/** One docker attach-protocol frame on stdout. */
function stdoutFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** The n-th exec the pipeline started (0-based), once it has. */
async function started(execs: StubExec[], n: number): Promise<StubExec> {
  await vi.waitFor(() => expect(execs.length).toBeGreaterThan(n));
  return execs[n] as StubExec;
}

/** The exec's end as dockerd reports it: exit recorded, stream closed. */
function end(exec: StubExec, exitCode: number) {
  exec.info = { ...exec.info, Running: false, ExitCode: exitCode };
  exec.stream.end();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DockerExecutor exec pipeline', () => {
  it('writes the in-container deadline it waits by: timeout --signal=KILL <seconds>', async () => {
    const { docker, execs } = stubDocker();
    const made = executor(docker).makeDir('box', '/home/user/p');
    const exec = await started(execs, 0);
    expect(exec.cmd.slice(0, 3)).toEqual([
      'timeout',
      '--signal=KILL',
      String(FILE_OP_TIMEOUT_SECONDS),
    ]);
    end(exec, 0);
    await expect(made).resolves.toBe(true);
  });

  it('an exec whose end dockerd never reports rejects past its deadline plus the grace, destroying its stream, and the next exec runs', async () => {
    vi.useFakeTimers();
    const logged: string[] = [];
    const { docker, execs } = stubDocker();
    const sandbox = executor(docker, (msg) => logged.push(msg));

    const lost = sandbox.makeDir('box', '/home/user/p');
    const outcome = expect(lost).rejects.toThrow(
      `reported no end within ${FILE_OP_TIMEOUT_SECONDS + EXEC_END_GRACE_SECONDS}s`,
    );
    await vi.advanceTimersByTimeAsync(
      (FILE_OP_TIMEOUT_SECONDS + EXEC_END_GRACE_SECONDS) * 1000,
    );
    await outcome;
    // Our side of the attach is let go — what dockerd was blocked on.
    expect((await started(execs, 0)).stream.destroyed).toBe(true);
    // Named in the log by the exec's own id, the handle dockerd answers to.
    expect(logged.join('\n')).toContain('exec exec-1 in box reported no end');

    // Nothing of the lost exec lingers: the sandbox's next exec is served.
    const next = sandbox.makeDir('box', '/home/user/q');
    end(await started(execs, 1), 0);
    await expect(next).resolves.toBe(true);
  });

  it('names a lost end for what inspect finds: dockerd still says running, the host process is gone', async () => {
    vi.useFakeTimers();
    const { docker } = stubDocker();
    const lost = executor(docker).statEntry('box', '/home/user');
    const outcome = expect(lost).rejects.toThrow(
      process.platform === 'linux'
        ? 'is gone and dockerd never recorded the exit'
        : 'is still running past its in-container deadline',
    );
    await vi.advanceTimersByTimeAsync(
      (FILE_OP_TIMEOUT_SECONDS + EXEC_END_GRACE_SECONDS) * 1000,
    );
    await outcome;
  });

  it('names a stream dockerd never closed after recording the exit', async () => {
    vi.useFakeTimers();
    const { docker, execs } = stubDocker();
    const lost = executor(docker).remove('box', '/home/user/p');
    const exec = await started(execs, 0);
    exec.info = { ...exec.info, Running: false, ExitCode: 0 };
    const outcome = expect(lost).rejects.toThrow(
      'dockerd recorded its exit (0) but never closed its stream',
    );
    await vi.advanceTimersByTimeAsync(
      (FILE_OP_TIMEOUT_SECONDS + EXEC_END_GRACE_SECONDS) * 1000,
    );
    await outcome;
  });

  it('a slow end inside the bound is waited for, and the bound retires with it', async () => {
    vi.useFakeTimers();
    const logged: string[] = [];
    const { docker, execs } = stubDocker();
    const made = executor(docker, (msg) => logged.push(msg)).makeDir(
      'box',
      '/home/user/p',
    );
    const exec = await started(execs, 0);
    await vi.advanceTimersByTimeAsync(
      (FILE_OP_TIMEOUT_SECONDS + EXEC_END_GRACE_SECONDS - 1) * 1000,
    );
    end(exec, 0);
    await expect(made).resolves.toBe(true);
    // The bound's timer went with the end: past it, nothing is said.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(logged).toEqual([]);
  });

  it('a process stream is bounded by the timeout it was started with', async () => {
    vi.useFakeTimers();
    const { docker } = stubDocker();
    const handle = await executor(docker).execStream('box', {
      command: 'sleep 1',
      timeoutSeconds: 5,
      onStdout: () => {},
      onStderr: () => {},
    });
    const outcome = expect(handle.wait()).rejects.toThrow(
      `reported no end within ${5 + EXEC_END_GRACE_SECONDS}s`,
    );
    await vi.advanceTimersByTimeAsync((5 + EXEC_END_GRACE_SECONDS) * 1000);
    await outcome;
  });

  it('output still on its way to its reader at the bound is the answer, said at the bound — though dockerd cannot answer an inspect', async () => {
    vi.useFakeTimers();
    const { docker, execs } = stubDocker();
    const handle = await executor(docker).execStream('box', {
      command: 'cat big',
      timeoutSeconds: 5,
      onStdout: () => new Promise<void>(() => {}),
      onStderr: () => {},
    });
    const exec = await started(execs, 0);
    exec.hangs = true;
    exec.stream.write(stdoutFrame('first chunk'));
    const outcome = expect(handle.wait()).rejects.toThrow(
      `reported no end within ${5 + EXEC_END_GRACE_SECONDS}s: its output was still being delivered`,
    );
    await vi.advanceTimersByTimeAsync((5 + EXEC_END_GRACE_SECONDS) * 1000);
    await outcome;
    expect(exec.stream.destroyed).toBe(true);
  });

  it('once dockerd has the process ended, the rest of its output is read at once — and still handed to the reader in order, at its pace', async () => {
    vi.useFakeTimers();
    const { docker, execs } = stubDocker();
    const reached: string[] = [];
    let take = () => {};
    const handle = await executor(docker).execStream('box', {
      command: 'cat big',
      timeoutSeconds: 600,
      onStdout: async (chunk) => {
        reached.push(chunk.toString('utf8'));
        await new Promise<void>((resolve) => {
          take = resolve;
        });
      },
      onStderr: () => {},
    });
    const exec = await started(execs, 0);
    // No host pid named: dockerd's record is the only word on the end.
    exec.info = { ...exec.info, Pid: 0 };
    exec.stream.write(stdoutFrame('a'));
    await vi.advanceTimersByTimeAsync(1);
    exec.stream.write(stdoutFrame('b'));
    exec.stream.write(stdoutFrame('c'));
    await vi.advanceTimersByTimeAsync(4 * END_PROBE_MS);
    // The process runs: the reader sets the pace, nothing is read past it.
    expect(exec.stream.readableLength).toBeGreaterThan(0);

    // dockerd has the exit — and would not close the stream before the rest
    // is read (moby #53614): the pump reads it.
    exec.info = { ...exec.info, Running: false, ExitCode: 0 };
    await vi.advanceTimersByTimeAsync(END_PROBE_MS);
    expect(exec.stream.readableLength).toBe(0);
    exec.stream.end();
    for (let i = 0; i < 3; i++) {
      take();
      await vi.advanceTimersByTimeAsync(1);
    }
    await expect(handle.wait()).resolves.toEqual({ exitCode: 0 });
    expect(reached).toEqual(['a', 'b', 'c']);
  });

  it('dockerd silent about the exec the pump waits behind reads as its end: the rest is read within a probe period plus the silence', async () => {
    vi.useFakeTimers();
    const { docker, execs } = stubDocker();
    let take = () => {};
    const handle = await executor(docker).execStream('box', {
      command: 'cat big',
      timeoutSeconds: 600,
      onStdout: async () => {
        await new Promise<void>((resolve) => {
          take = resolve;
        });
      },
      onStderr: () => {},
    });
    const exec = await started(execs, 0);
    exec.stream.write(stdoutFrame('a'));
    await vi.advanceTimersByTimeAsync(1);
    exec.stream.write(stdoutFrame('b'));
    // The process has ended, and dockerd's handling of the exit holds the
    // lock an inspect waits on — for as long as 'b' goes unread.
    exec.hangs = true;
    const answer = END_PROBE_MS + EXEC_END_SILENCE_SECONDS * 1000;
    await vi.advanceTimersByTimeAsync(answer - 2);
    expect(exec.stream.readableLength).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(exec.stream.readableLength).toBe(0);

    exec.hangs = false;
    end(exec, 0);
    for (let i = 0; i < 2; i++) {
      take();
      await vi.advanceTimersByTimeAsync(1);
    }
    await expect(handle.wait()).resolves.toEqual({ exitCode: 0 });
  });

  it('once dockerd has named the pid, the host alone answers: a process it still runs has not ended, whatever dockerd does', async () => {
    vi.useFakeTimers();
    const { docker, execs } = stubDocker();
    let take = () => {};
    const handle = await executor(docker).execStream('box', {
      command: 'cat big',
      timeoutSeconds: 600,
      onStdout: async () => {
        await new Promise<void>((resolve) => {
          take = resolve;
        });
      },
      onStderr: () => {},
    });
    const exec = await started(execs, 0);
    exec.info = { ...exec.info, Pid: process.pid };
    exec.stream.write(stdoutFrame('a'));
    await vi.advanceTimersByTimeAsync(1);
    exec.stream.write(stdoutFrame('b'));
    // Asked once while dockerd answers: the host's pid is learned. Then
    // dockerd falls silent — slow, not an exit: it is not asked again.
    await vi.advanceTimersByTimeAsync(END_PROBE_MS);
    exec.hangs = true;
    await vi.advanceTimersByTimeAsync(
      4 * (END_PROBE_MS + EXEC_END_SILENCE_SECONDS * 1000),
    );
    expect(exec.stream.readableLength).toBeGreaterThan(0);

    exec.hangs = false;
    end(exec, 0);
    for (let i = 0; i < 2; i++) {
      take();
      await vi.advanceTimersByTimeAsync(1);
    }
    await expect(handle.wait()).resolves.toEqual({ exitCode: 0 });
  });

  it('past the bound, output the pump still holds never reaches the reader', async () => {
    vi.useFakeTimers();
    const { docker, execs } = stubDocker();
    const reached: string[] = [];
    let take = () => {};
    const handle = await executor(docker).execStream('box', {
      command: 'cat big',
      timeoutSeconds: 5,
      onStdout: async (chunk) => {
        reached.push(chunk.toString('utf8'));
        await new Promise<void>((resolve) => {
          take = resolve;
        });
      },
      onStderr: () => {},
    });
    const exec = await started(execs, 0);
    exec.stream.write(stdoutFrame('a'));
    await vi.advanceTimersByTimeAsync(1);
    exec.stream.end(stdoutFrame('b'));
    exec.info = { ...exec.info, Running: false, ExitCode: 137 };
    const outcome = expect(handle.wait()).rejects.toThrow(
      'its output was still being delivered',
    );
    await vi.advanceTimersByTimeAsync((5 + EXEC_END_GRACE_SECONDS) * 1000);
    await outcome;
    take();
    await vi.advanceTimersByTimeAsync(1);
    expect(reached).toEqual(['a']);
  });

  it('a start that answers after its deadline has its stream destroyed on arrival', async () => {
    vi.useFakeTimers();
    let answer!: () => void;
    const { docker, execs } = stubDocker(
      (exec) =>
        new Promise((resolve) => {
          answer = () => resolve(exec.stream);
        }),
    );
    const failed = executor(docker).makeDir('box', '/home/user/p');
    const outcome = expect(failed).rejects.toThrow(
      `exec start in box got no answer from dockerd within ${VERB_DEADLINE_SECONDS}s`,
    );
    await vi.advanceTimersByTimeAsync(VERB_DEADLINE_SECONDS * 1000);
    await outcome;
    const exec = await started(execs, 0);
    answer();
    await vi.waitFor(() => expect(exec.stream.destroyed).toBe(true));
  });

  it('the watcher reads readiness and events off one pipe, readiness first — so onEvent may wait on the caller finishing its own start', async () => {
    const { docker, execs } = stubDocker();
    const events: string[] = [];
    // The E2B stream's gate: events wait for the start frame, which the
    // route writes only once watchDir has resolved.
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const watching = executor(docker).watchDir('box', {
      path: '/home/user',
      recursive: false,
      onEvent: async (event) => {
        await opened;
        events.push(`${event.type}:${event.name}`);
      },
      onEnd: () => {},
    });
    const exec = await started(execs, 0);
    // The script folds inotifywait's stderr into its stdout.
    expect(exec.cmd.join(' ')).toContain('2>&1');
    exec.stream.write(
      stdoutFrame(
        'Setting up watches.\nWatches established.\nCREATE|/home/user/a\n',
      ),
    );
    // Resolves with the event's handler already waiting on the gate.
    await watching;
    open();
    await vi.waitFor(() => expect(events).toEqual(['create:a']));
  });

  it('a watcher that fails to start reports what it said on the shared pipe', async () => {
    const { docker, execs } = stubDocker();
    const watching = executor(docker).watchDir('box', {
      path: '/home/user',
      recursive: false,
      onEvent: () => {},
      onEnd: () => {},
    });
    const exec = await started(execs, 0);
    exec.stream.write(
      stdoutFrame('Failed to watch /home/user; upper limit reached\n'),
    );
    end(exec, 1);
    await expect(watching).rejects.toThrow(
      'failed (exit 1): Failed to watch /home/user; upper limit reached',
    );
  });
});

describe('rootfsBytesOf', () => {
  it('reads the cap the overlay annotation names, GiB to bytes', () => {
    expect(rootfsBytesOf('root:self,size=50g')).toBe(50 * 1024 ** 3);
    expect(rootfsBytesOf('size=1g,root:self')).toBe(1024 ** 3);
  });

  it('a shell born before the cap names none: null', () => {
    expect(rootfsBytesOf(undefined)).toBeNull();
    expect(rootfsBytesOf('root:self')).toBeNull();
  });
});
