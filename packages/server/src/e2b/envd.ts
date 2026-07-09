import { Buffer } from 'node:buffer';
import { resolveSandboxPath } from '@dormice/shared';
import multipart from '@fastify/multipart';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { findBySandboxId, touch } from '../db/ledger';
import type { SandboxRow } from '../db/schema';
import { startExecHeartbeat } from '../exec-heartbeat';
import {
  DiskFullError,
  FileNotFoundError,
  NotADirectoryError,
  NotAFileError,
  type SandboxEntry,
  type WatchEvent,
} from '../executor/executor';
import { wakeSandbox } from '../lifecycle';
import type { E2bDeps } from './deps';
import type { ProcessRecord, ProcessSubscriber } from './process-table';
import {
  connectError,
  E2bError,
  envelope,
  FLAG_END_STREAM,
  FLAG_MESSAGE,
  readFirstMessage,
  verifyEnvdToken,
} from './protocol';
import { e2bView } from './view';
import { WatcherLimitError } from './watcher-table';

/**
 * The envd surface: what the official SDK reaches through its `sandboxUrl`
 * option. One origin serves every sandbox — the SDK attaches an
 * E2b-Sandbox-Id header to every request, so no wildcard DNS is needed.
 * Connect RPC rides the JSON codec (the SDK sets useBinaryFormat: false);
 * files ride plain HTTP. The daemon itself plays the role of envd — there
 * is no agent inside the container.
 */

/**
 * In-container cleanup backstop for e2b-surface processes. Deliberately not
 * the wire deadline: connect-timeout-ms only ever closes the stream — the
 * process lives until it exits, is signaled, or its sandbox dies (E2B's
 * semantics; the native /execCommand keeps its own kill-at-timeout contract).
 */
const MAX_EXEC_SECONDS = 24 * 60 * 60;

/** The SDK asks for keepalives via this header; we honor it, capped. */
const MAX_KEEPALIVE_SECONDS = 30;

/** Effectively unbounded route body: the disk quota is the real gate. */
const UNLIMITED_BODY_BYTES = Number.MAX_SAFE_INTEGER;

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

/** SandboxEntry -> proto3-JSON EntryInfo (int64 size travels as a string). */
function entryInfoJson(entry: SandboxEntry) {
  return {
    name: entry.name,
    type:
      entry.type === 'file'
        ? 'FILE_TYPE_FILE'
        : entry.type === 'dir'
          ? 'FILE_TYPE_DIRECTORY'
          : 'FILE_TYPE_UNSPECIFIED',
    path: entry.path,
    size: String(entry.sizeBytes),
    mode: entry.mode,
    permissions: permissionString(entry),
    owner: entry.owner,
    group: entry.group,
    modifiedTime: entry.modifiedTime,
  };
}

/** Go fs.FileMode style: type char + rwx triplets, display only. */
function permissionString(entry: SandboxEntry): string {
  const chars =
    entry.type === 'dir' ? ['d'] : entry.type === 'file' ? ['-'] : ['?'];
  for (let shift = 6; shift >= 0; shift -= 3) {
    const bits = (entry.mode >> shift) & 0o7;
    chars.push(
      bits & 4 ? 'r' : '-',
      bits & 2 ? 'w' : '-',
      bits & 1 ? 'x' : '-',
    );
  }
  return chars.join('');
}

/** Executor file errors -> the Connect codes the SDK maps back to its own taxonomy. */
function toConnectError(error: unknown): unknown {
  if (error instanceof FileNotFoundError) {
    return connectError('not_found', error.message);
  }
  if (error instanceof NotAFileError || error instanceof NotADirectoryError) {
    return connectError('invalid_argument', error.message);
  }
  if (error instanceof DiskFullError) {
    return connectError('resource_exhausted', error.message);
  }
  return error;
}

export const e2bEnvdRoutes: FastifyPluginAsyncZod<E2bDeps> = async (
  app,
  { config, db, executor, locks, processes, watchers },
) => {
  await app.register(multipart, {
    limits: {
      // The disk quota is the ceiling; a route-level cap would just be a
      // second, dishonest one. parts/files stay bounded so a hostile form
      // cannot spray unlimited entries.
      fileSize: UNLIMITED_BODY_BYTES,
      files: 1000,
      parts: 2000,
      fieldSize: 1024 * 1024,
    },
    // busboy strips filenames to their basename by default (a browser-form
    // safety net); here the filename IS the destination path — 'notes/x.txt'
    // must keep its directory. Traversal is not a concern this opens:
    // resolveSandboxPath clamps '..' at the container's own root anyway.
    preservePath: true,
  });

  // Connect streaming requests arrive enveloped; keep the raw bytes.
  app.addContentTypeParser(
    'application/connect+json',
    { parseAs: 'buffer' },
    (_request, payload, done) => done(null, payload),
  );
  // Octet-stream uploads pass through as a stream: nothing materializes.
  app.addContentTypeParser(
    'application/octet-stream',
    (_request, payload, done) => done(null, payload),
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof E2bError) {
      return reply
        .code(error.statusCode)
        .send({ code: error.code, message: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error, 'e2b envd request failed');
    }
    return reply.code(status).send({
      code: status === 400 ? 'invalid_argument' : 'internal',
      message: (error as Error).message,
    });
  });
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      code: 'not_found',
      message: `route ${request.method} ${request.url} not found`,
    });
  });

  /** Every envd request names its sandbox in this header. */
  function sandboxIdOf(request: FastifyRequest): string {
    const header = request.headers['e2b-sandbox-id'];
    const id = Array.isArray(header) ? header[0] : header;
    if (!id) {
      throw new E2bError(
        401,
        'unauthenticated',
        'missing E2b-Sandbox-Id header',
      );
    }
    return id;
  }

  // Auth: X-Access-Token must be the HMAC minted for exactly this sandbox.
  // /health stays open like real envd's — it is how isRunning() probes.
  app.addHook('onRequest', async (request) => {
    if (request.method === 'GET' && request.url.endsWith('/health')) return;
    const sandboxId = sandboxIdOf(request);
    const header = request.headers['x-access-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (
      !token ||
      !verifyEnvdToken(config.DORMICE_API_TOKEN, sandboxId, token)
    ) {
      throw new E2bError(401, 'unauthenticated', 'invalid envd access token');
    }
  });

  /**
   * The protocol-liveness gate. Only a logically-running sandbox serves
   * envd traffic: paused and dead answer 502, which the SDK triages into
   * its "sandbox timed out / not running" errors — exactly what talking to
   * a paused or killed E2B sandbox feels like.
   */
  function requireRunningRow(sandboxId: string): SandboxRow {
    const row = findBySandboxId(db, sandboxId);
    if (!row) {
      throw new E2bError(502, 'unavailable', 'sandbox not found');
    }
    const state = e2bView(row, new Date());
    if (state !== 'running') {
      throw new E2bError(
        502,
        'unavailable',
        state === 'paused' ? 'sandbox is paused' : 'sandbox not found',
      );
    }
    return row;
  }

  /**
   * Wake under the key's slot, like every native verb: physical wake-ups
   * take seconds and must not race the scanner or a release.
   */
  async function wakeForUse(sandboxId: string): Promise<SandboxRow> {
    const before = requireRunningRow(sandboxId);
    return locks.run(before.userKey, async () => {
      const fresh = requireRunningRow(sandboxId);
      const awake = await wakeSandbox(db, executor, fresh);
      return touch(db, awake.sandboxId);
    });
  }

  app.get('/health', async (request, reply) => {
    // No auth, no wake — a probe must stay cheap and honest. 502 = not
    // running, the exact signal isRunning() keys on.
    const header = request.headers['e2b-sandbox-id'];
    const id = Array.isArray(header) ? header[0] : header;
    const row = id ? findBySandboxId(db, id) : undefined;
    if (!row || e2bView(row, new Date()) !== 'running') {
      return reply
        .code(502)
        .send({ code: 'unavailable', message: 'sandbox is not running' });
    }
    return reply.code(204).send();
  });

  // ---- files over plain HTTP ------------------------------------------

  app.get('/files', async (request, reply) => {
    const query = request.query as { path?: string };
    if (!query.path) {
      throw new E2bError(400, 'invalid_argument', 'missing path query');
    }
    const row = await wakeForUse(sandboxIdOf(request));
    const stopHeartbeat = startExecHeartbeat(
      db,
      row.sandboxId,
      row.freezeAfterSeconds,
    );
    try {
      let entry: SandboxEntry;
      try {
        entry = await executor.statEntry(row.sandboxId, query.path);
        if (entry.type !== 'file') {
          throw new NotAFileError(`not a regular file: ${entry.path}`);
        }
      } catch (error) {
        if (error instanceof FileNotFoundError) {
          throw new E2bError(404, 'not_found', error.message);
        }
        if (error instanceof NotAFileError) {
          throw new E2bError(400, 'invalid_argument', error.message);
        }
        throw error;
      }
      // Size first, then stream: the SDK needs content-length (an empty
      // file is detected by `content-length: 0`), and nothing buffers here.
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(entry.sizeBytes),
      });
      await executor.readFileStream(row.sandboxId, query.path, (chunk) => {
        if (!reply.raw.write(chunk)) {
          // Backpressure: the promise pauses the pipe all the way into the
          // container until the client drains.
          return new Promise<void>((resolve) =>
            reply.raw.once('drain', resolve),
          );
        }
      });
      reply.raw.end();
    } catch (error) {
      if (reply.raw.headersSent) {
        // Mid-stream failure: the body length will not match the announced
        // content-length — the client sees a broken transfer, honestly.
        request.log.error(error, 'file download broke mid-stream');
        reply.raw.destroy();
        return;
      }
      throw error;
    } finally {
      stopHeartbeat();
      try {
        touch(db, row.sandboxId);
      } catch {
        // Released mid-transfer; the transfer's own error tells the story.
      }
    }
  });

  app.post(
    '/files',
    { bodyLimit: UNLIMITED_BODY_BYTES },
    async (request, reply) => {
      const query = request.query as { path?: string };
      const row = await wakeForUse(sandboxIdOf(request));
      const stopHeartbeat = startExecHeartbeat(
        db,
        row.sandboxId,
        row.freezeAfterSeconds,
      );
      try {
        const written: Array<{ name: string; type: 'file'; path: string }> = [];
        const writeOne = async (
          path: string,
          content: NodeJS.ReadableStream,
        ) => {
          try {
            await executor.writeFileStream(row.sandboxId, path, content);
          } catch (error) {
            if (error instanceof NotAFileError) {
              throw new E2bError(400, 'invalid_argument', error.message);
            }
            if (error instanceof DiskFullError) {
              throw new E2bError(507, 'not_enough_space', error.message);
            }
            throw error;
          }
          const resolved = resolveSandboxPath(path);
          written.push({
            name: resolved.slice(resolved.lastIndexOf('/') + 1),
            type: 'file',
            path: resolved,
          });
        };

        if (request.isMultipart()) {
          // The SDK's default upload shape: one part per file, field name
          // `file`, the part's filename carrying the destination path.
          for await (const part of request.parts()) {
            if (part.type !== 'file') continue;
            const destination = part.filename || query.path;
            if (!destination) {
              throw new E2bError(
                400,
                'invalid_argument',
                'multipart file part has no filename and no ?path= fallback',
              );
            }
            await writeOne(destination, part.file);
          }
        } else {
          // Octet-stream (the SDK's streaming/gzip shape): path in the query.
          if (!query.path) {
            throw new E2bError(400, 'invalid_argument', 'missing path query');
          }
          await writeOne(query.path, request.body as NodeJS.ReadableStream);
        }
        return await reply.code(200).send(written);
      } finally {
        stopHeartbeat();
        try {
          touch(db, row.sandboxId);
        } catch {
          // Released mid-upload; the upload's own result tells the story.
        }
      }
    },
  );

  // ---- filesystem service (Connect RPC, unary, JSON codec) ------------

  /** Unary filesystem RPCs run entirely in the key's slot, like native file verbs. */
  async function inSlot<T>(
    sandboxId: string,
    work: (row: SandboxRow) => Promise<T>,
  ): Promise<T> {
    const before = requireRunningRow(sandboxId);
    return locks.run(before.userKey, async () => {
      const fresh = requireRunningRow(sandboxId);
      const awake = await wakeSandbox(db, executor, fresh);
      const row = touch(db, awake.sandboxId);
      try {
        return await work(row);
      } catch (error) {
        throw toConnectError(error);
      }
    });
  }

  app.post('/filesystem.Filesystem/Stat', async (request) => {
    const body = request.body as { path?: string };
    if (!body.path) throw connectError('invalid_argument', 'missing path');
    const entry = await inSlot(sandboxIdOf(request), (row) =>
      executor.statEntry(row.sandboxId, body.path as string),
    );
    return { entry: entryInfoJson(entry) };
  });

  app.post('/filesystem.Filesystem/ListDir', async (request) => {
    const body = request.body as { path?: string; depth?: number };
    if (!body.path) throw connectError('invalid_argument', 'missing path');
    const depth = body.depth ?? 1;
    if (depth < 1) {
      throw connectError('invalid_argument', 'depth should be at least one');
    }
    const entries = await inSlot(sandboxIdOf(request), (row) =>
      executor.listDir(row.sandboxId, body.path as string, depth),
    );
    return { entries: entries.map(entryInfoJson) };
  });

  app.post('/filesystem.Filesystem/MakeDir', async (request) => {
    const body = request.body as { path?: string };
    if (!body.path) throw connectError('invalid_argument', 'missing path');
    const entry = await inSlot(sandboxIdOf(request), async (row) => {
      const created = await executor.makeDir(
        row.sandboxId,
        body.path as string,
      );
      if (!created) {
        // The SDK reads already_exists as makeDir() === false.
        throw connectError(
          'already_exists',
          `already exists: ${resolveSandboxPath(body.path as string)}`,
        );
      }
      return executor.statEntry(row.sandboxId, body.path as string);
    });
    return { entry: entryInfoJson(entry) };
  });

  app.post('/filesystem.Filesystem/Move', async (request) => {
    const body = request.body as { source?: string; destination?: string };
    if (!body.source || !body.destination) {
      throw connectError('invalid_argument', 'missing source or destination');
    }
    const entry = await inSlot(sandboxIdOf(request), (row) =>
      executor.move(
        row.sandboxId,
        body.source as string,
        body.destination as string,
      ),
    );
    return { entry: entryInfoJson(entry) };
  });

  app.post('/filesystem.Filesystem/Remove', async (request) => {
    const body = request.body as { path?: string };
    if (!body.path) throw connectError('invalid_argument', 'missing path');
    await inSlot(sandboxIdOf(request), (row) =>
      executor.remove(row.sandboxId, body.path as string),
    );
    return {};
  });

  // ---- directory watching ----------------------------------------------

  /** Executor event types -> the proto enum names proto3-JSON speaks. */
  const WATCH_EVENT_WIRE: Record<WatchEvent['type'], string> = {
    create: 'EVENT_TYPE_CREATE',
    write: 'EVENT_TYPE_WRITE',
    remove: 'EVENT_TYPE_REMOVE',
    rename: 'EVENT_TYPE_RENAME',
    chmod: 'EVENT_TYPE_CHMOD',
  };

  /**
   * Path validation errors travel differently on the two watch surfaces
   * (in-stream frame vs unary throw), but the codes and messages are one
   * decision: not_found for a missing path, invalid_argument for a file —
   * real envd's answers, with this codebase's own wording.
   */
  function watchStartError(error: unknown): { code: string; message: string } {
    if (error instanceof FileNotFoundError) {
      return { code: 'not_found', message: error.message };
    }
    if (error instanceof NotADirectoryError) {
      return { code: 'invalid_argument', message: error.message };
    }
    return {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  /**
   * The streaming watch: unlike a process stream, the watcher IS the stream
   * — real envd runs the whole watch inside one handler, so the deadline,
   * the client hanging up, or any ending stops the watcher itself (the SDK's
   * WatchHandle.stop() is exactly an abort of this request). Frames are the
   * WatchDirResponse oneof at the top level: {start:{}}, {filesystem:{...}},
   * {keepalive:{}} — no `event` wrapper, unlike the process face.
   *
   * Deliberately no exec heartbeat: watching is passive observation, so an
   * attached watch lets the idle scanner freeze the sandbox. No events can
   * be missed frozen — the disk only changes from inside, and everything
   * that reaches inside wakes the sandbox first.
   */
  app.post('/filesystem.Filesystem/WatchDir', async (request, reply) => {
    const message = readFirstMessage(request.body as Buffer) as {
      path?: string;
      recursive?: boolean;
    };
    if (!message.path) {
      return streamError(reply, 'invalid_argument', 'missing path');
    }
    const row = await wakeForStream(request, reply);
    if (!row) return;

    const write = rawWriter(reply);
    // Events hold at this gate until the start frame is on the wire — the
    // SDK requires the stream to open with it, and a change made in the
    // sliver between watcher start and hijack would otherwise race ahead.
    let openGate = () => {};
    const opened = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let settleEnd: (error: Error) => void = () => {};
    const ended = new Promise<Error>((resolve) => {
      settleEnd = resolve;
    });
    let watcher: Awaited<ReturnType<typeof executor.watchDir>>;
    try {
      watcher = await executor.watchDir(row.sandboxId, {
        path: message.path,
        recursive: message.recursive === true,
        onEvent: async (event) => {
          await opened;
          await write(
            envelope(FLAG_MESSAGE, {
              filesystem: {
                name: event.name,
                type: WATCH_EVENT_WIRE[event.type],
              },
            }),
          );
        },
        onEnd: (error) =>
          settleEnd(error ?? new Error('watcher ended unexpectedly')),
      });
    } catch (error) {
      const { code, message: text } = watchStartError(error);
      return streamError(reply, code, text);
    }

    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'application/connect+json' });
    await write(envelope(FLAG_MESSAGE, { start: {} }));
    openGate();

    const keepaliveSeconds = Math.min(
      Number(request.headers['keepalive-ping-interval']) ||
        MAX_KEEPALIVE_SECONDS,
      MAX_KEEPALIVE_SECONDS,
    );
    const keepalive = setInterval(() => {
      reply.raw.write(envelope(FLAG_MESSAGE, { keepalive: {} }));
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
      const outcome = await Promise.race([ended, deadline, clientGone]);
      if (outcome === 'deadline') {
        // The SDK's watch default is 60s: a blown deadline is the normal
        // ending of most watches, answered like real envd's ctx expiry.
        await write(
          envelope(FLAG_END_STREAM, {
            error: {
              code: 'deadline_exceeded',
              message: `watch timed out after ${deadlineMs}ms`,
            },
          }),
        );
      } else if (outcome instanceof Error) {
        await write(
          envelope(FLAG_END_STREAM, {
            error: { code: 'internal', message: outcome.message },
          }),
        );
      }
    } finally {
      clearInterval(keepalive);
      clearTimeout(deadlineTimer);
      try {
        await watcher.stop();
      } catch {
        // The sandbox died under the watcher; its ending already spoke.
      }
      reply.raw.end();
    }
  });

  // The polling trio — what the sync SDKs use instead of the WatchDir
  // stream. Same watcher engine, parked in the daemon-memory watcher table.

  app.post('/filesystem.Filesystem/CreateWatcher', async (request) => {
    const body = request.body as { path?: string; recursive?: boolean };
    if (!body.path) throw connectError('invalid_argument', 'missing path');
    const row = await wakeForUse(sandboxIdOf(request));
    try {
      const watcherId = await watchers.create({
        executor,
        sandboxId: row.sandboxId,
        path: body.path,
        recursive: body.recursive === true,
      });
      return { watcherId };
    } catch (error) {
      if (error instanceof WatcherLimitError) {
        throw connectError('resource_exhausted', error.message);
      }
      const { code, message } = watchStartError(error);
      throw connectError(code, message);
    }
  });

  app.post('/filesystem.Filesystem/GetWatcherEvents', async (request) => {
    const body = request.body as { watcherId?: string };
    if (!body.watcherId) {
      throw connectError('invalid_argument', 'missing watcher id');
    }
    // No wake: this reads daemon memory. A frozen sandbox has no new events
    // to report anyway — the disk cannot change while it is frozen.
    const row = requireRunningRow(sandboxIdOf(request));
    const events = watchers.drain(row.sandboxId, body.watcherId);
    if (events === undefined) {
      throw connectError(
        'not_found',
        `watcher with id ${body.watcherId} not found`,
      );
    }
    return {
      events: events.map((event) => ({
        name: event.name,
        type: WATCH_EVENT_WIRE[event.type],
      })),
    };
  });

  app.post('/filesystem.Filesystem/RemoveWatcher', async (request) => {
    const body = request.body as { watcherId?: string };
    if (!body.watcherId) {
      throw connectError('invalid_argument', 'missing watcher id');
    }
    // Wakes: stopping the in-container inotifywait needs the container up.
    const row = await wakeForUse(sandboxIdOf(request));
    const removed = await watchers.remove(row.sandboxId, body.watcherId);
    if (!removed) {
      throw connectError(
        'not_found',
        `watcher with id ${body.watcherId} not found`,
      );
    }
    return {};
  });

  // ---- process service -------------------------------------------------

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
                // The container died under the process (a kill, a release):
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

  /** The SDK's connect-timeout-ms header, absent meaning "effectively never". */
  function wireDeadlineMs(request: FastifyRequest): number {
    const headerMs = Number(request.headers['connect-timeout-ms']);
    return Number.isFinite(headerMs) && headerMs > 0
      ? headerMs
      : MAX_EXEC_SECONDS * 1000;
  }

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

  /** Wake-for-use with streaming-dialect errors: streamError, not thrown JSON. */
  async function wakeForStream(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SandboxRow | undefined> {
    try {
      return await wakeForUse(sandboxIdOf(request));
    } catch (error) {
      if (error instanceof E2bError) {
        // Everything this surface throws carries a Connect string code; a
        // numeric one would be a control-plane error that leaked — treat it
        // as the sandbox being unreachable.
        streamError(
          reply,
          typeof error.code === 'string' ? error.code : 'unavailable',
          error.message,
        );
        return undefined;
      }
      throw error;
    }
  }

  /** The backpressured raw write every process stream shares. */
  function rawWriter(reply: FastifyReply): (buf: Buffer) => Promise<void> {
    return (buf) =>
      new Promise<void>((resolve) => {
        if (!reply.raw.write(buf)) reply.raw.once('drain', resolve);
        else resolve();
      });
  }

  app.post('/process.Process/List', async (request) => {
    // Read-only: no wake — looking at the table must not thaw a sandbox.
    const row = requireRunningRow(sandboxIdOf(request));
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
    const row = await wakeForStream(request, reply);
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
    const row = await wakeForStream(request, reply);
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

  /** {process:{pid}} — the proto3-JSON flattening of the selector oneof. */
  function requirePid(body: unknown): number {
    const pid = (body as { process?: { pid?: unknown } })?.process?.pid;
    if (typeof pid !== 'number') {
      throw connectError('invalid_argument', 'missing process pid');
    }
    return pid;
  }

  /** A living process for this sandbox, or the not_found the SDK expects. */
  function requireProcess(sandboxId: string, pid: number): ProcessRecord {
    const record = processes.get(sandboxId, pid);
    if (!record) {
      throw connectError('not_found', `process not found: ${pid}`);
    }
    return record;
  }

  app.post('/process.Process/SendInput', async (request) => {
    const body = request.body as {
      process?: { pid?: number };
      input?: { stdin?: string; pty?: string };
    };
    const pid = requirePid(body);
    const row = await wakeForUse(sandboxIdOf(request));
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
    const row = await wakeForUse(sandboxIdOf(request));
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
    const row = await wakeForUse(sandboxIdOf(request));
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
    const row = await wakeForUse(sandboxIdOf(request));
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

  /** Streaming endpoints answer errors inside the stream: 200 + end-stream frame. */
  function streamError(
    reply: FastifyReply,
    code: string,
    message: string,
  ): void {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'application/connect+json' });
    reply.raw.write(envelope(FLAG_END_STREAM, { error: { code, message } }));
    reply.raw.end();
  }

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
};
