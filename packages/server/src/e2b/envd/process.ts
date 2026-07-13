import { Buffer } from 'node:buffer';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { touch } from '../../db/ledger';
import type { SandboxRow } from '../../db/schema';
import { startExecHeartbeat } from '../../exec-heartbeat';
import type { ProcessRecord, ProcessSubscriber } from '../process-table';
import {
  connectError,
  envelope,
  FLAG_END_STREAM,
  FLAG_MESSAGE,
  readFirstMessage,
} from '../protocol';
import {
  type EnvdContext,
  MAX_EXEC_SECONDS,
  MAX_KEEPALIVE_SECONDS,
  rawWriter,
  sandboxIdOf,
  streamError,
  usernameOf,
  vetUsername,
  wireDeadlineMs,
} from './shared';

interface StartRequest {
  process?: {
    cmd?: string;
    args?: string[];
    envs?: Record<string, string>;
    cwd?: string;
  };
  stdin?: boolean;
  pty?: { size?: { cols?: number; rows?: number } };
}

/**
 * The wire face of one attached stream, shared by Start and Connect: data
 * frames with backpressure, and the end frames written by the process's
 * finalize. `done` settles once the ending — end event or in-stream error
 * — is fully on the wire. The write closure touches reply.raw lazily: it
 * is never called before the caller has hijacked (the executor emits
 * nothing before execStream resolves, and subscription follows the
 * hijack synchronously).
 */
function streamSubscriber(write: (buf: Buffer) => Promise<void>): {
  subscriber: ProcessSubscriber;
  done: Promise<'ended'>;
} {
  let resolveDone!: (outcome: 'ended') => void;
  const done = new Promise<'ended'>((resolve) => {
    resolveDone = resolve;
  });
  const subscriber: ProcessSubscriber = {
    onOutput: (channel, chunk) =>
      write(
        envelope(FLAG_MESSAGE, {
          event: { data: { [channel]: chunk.toString('base64') } },
        }),
      ),
    onEnd: (end) => {
      const frames =
        end.kind === 'exit'
          ? [
              envelope(FLAG_MESSAGE, {
                event: {
                  end: {
                    exitCode: end.exitCode,
                    exited: true,
                    status: end.exitCode === 137 ? 'killed' : 'exited',
                    ...(end.exitCode === 137
                      ? { error: 'command killed (exit 137)' }
                      : {}),
                  },
                },
              }),
              envelope(FLAG_END_STREAM, {}),
            ]
          : [
              // The container died under the process (a kill, a destroy):
              // an in-stream internal error, which the SDK triages via its
              // health check — the same feel as a killed E2B sandbox.
              envelope(FLAG_END_STREAM, {
                error: { code: 'internal', message: end.message },
              }),
            ];
      void (async () => {
        for (const frame of frames) await write(frame);
        resolveDone('ended');
      })();
    },
  };
  return { subscriber, done };
}

/** {process:{pid}} — the proto3-JSON flattening of the selector oneof. */
function requirePid(body: unknown): number {
  const pid = (body as { process?: { pid?: unknown } })?.process?.pid;
  if (typeof pid !== 'number') {
    throw connectError('invalid_argument', 'missing process pid');
  }
  return pid;
}

/** The Process service: streams, input, signals, resize — E2B's process model. */
export function registerProcessRoutes(
  app: FastifyInstance,
  ctx: EnvdContext,
): void {
  const { db, executor, processes } = ctx;

  /**
   * The attached half of a process stream: keepalives, the wire deadline,
   * the client hanging up. The deadline and the hang-up both merely detach
   * this stream — the process keeps running (real envd's semantics: nothing
   * kills a process except its own exit, SendSignal, or the sandbox dying);
   * the exec heartbeat lives exactly as long as someone is attached, so a
   * background process nobody watches lets the sandbox freeze honestly.
   */
  async function pumpProcessStream(args: {
    request: FastifyRequest;
    reply: FastifyReply;
    row: SandboxRow;
    write: (buf: Buffer) => Promise<void>;
    done: Promise<'ended'>;
    detach: () => void;
  }): Promise<void> {
    const { request, reply, row, write, done, detach } = args;
    const stopHeartbeat = startExecHeartbeat(
      db,
      row.sandboxId,
      row.freezeAfterSeconds,
    );
    // Keepalive events on the interval the SDK asked for — what keeps
    // proxies from cutting a silent long command.
    const keepaliveSeconds = Math.min(
      Number(request.headers['keepalive-ping-interval']) ||
        MAX_KEEPALIVE_SECONDS,
      MAX_KEEPALIVE_SECONDS,
    );
    const keepalive = setInterval(() => {
      reply.raw.write(envelope(FLAG_MESSAGE, { event: { keepalive: {} } }));
    }, keepaliveSeconds * 1000);
    const deadlineMs = wireDeadlineMs(request);
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      deadlineTimer = setTimeout(() => resolve('deadline'), deadlineMs);
    });
    const clientGone = new Promise<'gone'>((resolve) => {
      reply.raw.once('close', () => resolve('gone'));
    });
    try {
      const outcome = await Promise.race([done, deadline, clientGone]);
      if (outcome === 'deadline') {
        // Real envd answers a blown deadline with the Connect error, not an
        // end event; the SDK turns it into its TimeoutError. The process
        // stays alive — only this stream ends.
        await write(
          envelope(FLAG_END_STREAM, {
            error: {
              code: 'deadline_exceeded',
              message: `command timed out after ${deadlineMs}ms`,
            },
          }),
        );
      }
    } finally {
      clearInterval(keepalive);
      clearTimeout(deadlineTimer);
      detach();
      stopHeartbeat();
      try {
        // Watching the command was the activity: the idle countdown starts
        // when the stream detaches, not when it attached.
        touch(db, row.sandboxId);
      } catch {
        // Released mid-stream; the stream's own ending tells the story.
      }
      reply.raw.end();
    }
  }

  /** A living process for this sandbox, or the not_found the SDK expects. */
  function requireProcess(sandboxId: string, pid: number): ProcessRecord {
    const record = processes.get(sandboxId, pid);
    if (!record) {
      throw connectError('not_found', `process not found: ${pid}`);
    }
    return record;
  }

  app.post('/process.Process/List', async (request) => {
    // Read-only: no wake — looking at the table must not thaw a sandbox.
    const row = ctx.requireRunningRow(sandboxIdOf(request));
    return {
      processes: processes.list(row.sandboxId).map((record) => ({
        pid: record.pid,
        // config is echoed verbatim and always complete: the SDK
        // dereferences processes[].config.args unconditionally.
        config: {
          cmd: record.config.cmd,
          args: record.config.args,
          envs: record.config.envs,
          ...(record.config.cwd ? { cwd: record.config.cwd } : {}),
        },
      })),
    };
  });

  app.post('/process.Process/Start', async (request, reply) => {
    const message = readFirstMessage(request.body as Buffer) as StartRequest;
    const proc = message.process ?? {};
    const args = proc.args ?? [];
    // A pty block makes this a terminal session (the SDK sends
    // /bin/bash -i -l; the executor hardcodes that shape anyway). Sizes
    // default defensively — a 0x0 terminal misbehaves quietly.
    const ptySize = message.pty
      ? {
          cols: message.pty.size?.cols || 80,
          rows: message.pty.size?.rows || 24,
        }
      : undefined;
    // Without a pty, the SDK always sends /bin/bash [-l] -c <command>;
    // anything else is a shape this layer does not speak yet.
    let command: string | undefined;
    let loginShell = false;
    if (args.length === 3 && args[0] === '-l' && args[1] === '-c') {
      command = args[2];
      loginShell = true;
    } else if (args.length === 2 && args[0] === '-c') {
      command = args[1];
    }
    if (!proc.cmd?.endsWith('bash') || (!ptySize && command === undefined)) {
      return streamError(
        reply,
        'invalid_argument',
        ptySize
          ? 'only bash PTY sessions are supported'
          : 'only shell commands are supported: expected /bin/bash [-l] -c <command>',
      );
    }
    // Identity rides the Basic auth header (SDK: user option); vetted here,
    // in the streaming dialect, before anything wakes.
    let user: string | undefined;
    try {
      user = vetUsername(usernameOf(request));
    } catch (error) {
      const e = error as { code: string | number; message: string };
      return streamError(reply, String(e.code), e.message);
    }
    const row = await ctx.wakeForStream(request, reply);
    if (!row) return;

    const sandboxEnvs: Record<string, string> = row.envs
      ? JSON.parse(row.envs)
      : {};
    const write = rawWriter(reply);
    const { subscriber, done } = streamSubscriber(write);
    let record: ProcessRecord;
    try {
      record = await processes.start({
        executor,
        sandboxId: row.sandboxId,
        options: {
          command,
          loginShell,
          pty: ptySize,
          // The in-container timeout is a pathological-cleanup backstop
          // only; the wire deadline lives in pumpProcessStream and never
          // kills the process — E2B's semantics, adopted deliberately.
          timeoutSeconds: MAX_EXEC_SECONDS,
          stdin: message.stdin === true,
          cwd: proc.cwd,
          user,
          // Sandbox-level envs underneath, per-command envs on top.
          env: { ...sandboxEnvs, ...(proc.envs ?? {}) },
        },
        config: {
          cmd: proc.cmd,
          args,
          envs: proc.envs ?? {},
          cwd: proc.cwd,
        },
        subscriber,
      });
    } catch (error) {
      // Start order is deliberate: the start frame goes out only for a
      // process that actually started.
      const messageText =
        error instanceof Error ? error.message : String(error);
      return streamError(reply, 'internal', messageText);
    }
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'application/connect+json' });
    await write(
      envelope(FLAG_MESSAGE, { event: { start: { pid: record.pid } } }),
    );
    await pumpProcessStream({
      request,
      reply,
      row,
      write,
      done,
      detach: () => processes.unsubscribe(record.pid, subscriber),
    });
  });

  app.post('/process.Process/Connect', async (request, reply) => {
    const message = readFirstMessage(request.body as Buffer) as {
      process?: { pid?: number };
    };
    const pid = message.process?.pid;
    if (typeof pid !== 'number') {
      return streamError(reply, 'invalid_argument', 'missing process pid');
    }
    const row = await ctx.wakeForStream(request, reply);
    if (!row) return;
    const record = processes.get(row.sandboxId, pid);
    if (!record) {
      return streamError(reply, 'not_found', `process not found: ${pid}`);
    }
    const write = rawWriter(reply);
    const { subscriber, done } = streamSubscriber(write);
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'application/connect+json' });
    // The SDK requires a Connect stream to open with a start frame, exactly
    // like Start's. Initiated before subscribing so no data frame can slip
    // ahead of it (raw writes keep call order). No replay of past output —
    // real envd's semantics.
    const startFrame = write(
      envelope(FLAG_MESSAGE, { event: { start: { pid: record.pid } } }),
    );
    const unsubscribe = processes.subscribe(pid, subscriber);
    await startFrame;
    if (!unsubscribe) {
      // Finished between get and subscribe: report it rather than hold a
      // stream that would never end.
      await write(
        envelope(FLAG_END_STREAM, {
          error: { code: 'not_found', message: `process not found: ${pid}` },
        }),
      );
      reply.raw.end();
      return;
    }
    await pumpProcessStream({
      request,
      reply,
      row,
      write,
      done,
      detach: unsubscribe,
    });
  });

  app.post('/process.Process/SendInput', async (request) => {
    const body = request.body as {
      process?: { pid?: number };
      input?: { stdin?: string; pty?: string };
    };
    const pid = requirePid(body);
    const row = await ctx.wakeForUse(sandboxIdOf(request));
    const record = requireProcess(row.sandboxId, pid);
    const stdinB64 = body.input?.stdin;
    const ptyB64 = body.input?.pty;
    if (typeof stdinB64 !== 'string' && typeof ptyB64 !== 'string') {
      throw connectError('invalid_argument', 'missing input');
    }
    // Channel and promise must match: stdin input needs a stdin:true start,
    // pty input needs a PTY session — a mismatch is the caller's confusion.
    if (typeof stdinB64 === 'string' && !record.stdin) {
      throw connectError(
        'invalid_argument',
        'process was started without stdin',
      );
    }
    if (typeof ptyB64 === 'string' && !record.pty) {
      throw connectError('invalid_argument', 'process has no PTY');
    }
    const data = Buffer.from((stdinB64 ?? ptyB64) as string, 'base64');
    try {
      await record.handle.sendStdin(data);
    } catch (error) {
      throw connectError(
        'invalid_argument',
        error instanceof Error ? error.message : String(error),
      );
    }
    return {};
  });

  app.post('/process.Process/CloseStdin', async (request) => {
    const pid = requirePid(request.body);
    const row = await ctx.wakeForUse(sandboxIdOf(request));
    const record = requireProcess(row.sandboxId, pid);
    if (!record.stdin) {
      throw connectError(
        'invalid_argument',
        'process was started without stdin',
      );
    }
    try {
      await record.handle.closeStdin();
    } catch (error) {
      throw connectError(
        'invalid_argument',
        error instanceof Error ? error.message : String(error),
      );
    }
    return {};
  });

  app.post('/process.Process/SendSignal', async (request) => {
    const body = request.body as {
      process?: { pid?: number };
      signal?: string | number;
    };
    const pid = requirePid(body);
    // proto3-JSON enums travel as their names; a numeric fallback costs
    // nothing and covers a client that emits raw values.
    const sig =
      body.signal === 'SIGNAL_SIGKILL' || body.signal === 9
        ? ('SIGKILL' as const)
        : body.signal === 'SIGNAL_SIGTERM' || body.signal === 15
          ? ('SIGTERM' as const)
          : undefined;
    if (!sig) {
      throw connectError(
        'invalid_argument',
        `unsupported signal: ${String(body.signal)} — only SIGKILL and SIGTERM are supported`,
      );
    }
    const row = await ctx.wakeForUse(sandboxIdOf(request));
    const record = requireProcess(row.sandboxId, pid);
    try {
      await record.handle.signal(sig);
    } catch {
      // The process ended between lookup and signal: protocol-wise it does
      // not exist — the SDK turns not_found into kill() === false.
      throw connectError('not_found', `process not found: ${pid}`);
    }
    return {};
  });

  app.post('/process.Process/Update', async (request) => {
    const body = request.body as {
      process?: { pid?: number };
      pty?: { size?: { cols?: number; rows?: number } };
    };
    const pid = requirePid(body);
    const row = await ctx.wakeForUse(sandboxIdOf(request));
    const record = requireProcess(row.sandboxId, pid);
    if (!record.pty) {
      throw connectError('invalid_argument', 'process has no PTY');
    }
    const size = body.pty?.size;
    if (
      typeof size?.cols !== 'number' ||
      typeof size?.rows !== 'number' ||
      size.cols <= 0 ||
      size.rows <= 0
    ) {
      throw connectError('invalid_argument', 'missing pty size');
    }
    try {
      await record.handle.resizePty({ cols: size.cols, rows: size.rows });
    } catch (error) {
      throw connectError(
        'invalid_argument',
        error instanceof Error ? error.message : String(error),
      );
    }
    return {};
  });

  // ---- honest unimplemented stubs --------------------------------------

  const unimplemented: Array<[string, string]> = [
    [
      '/process.Process/StreamInput',
      'streamed stdin is not supported — the SDK sends stdin via SendInput',
    ],
  ];
  for (const [path, hint] of unimplemented) {
    app.post(path, async () => {
      throw connectError('unimplemented', hint);
    });
  }
}
