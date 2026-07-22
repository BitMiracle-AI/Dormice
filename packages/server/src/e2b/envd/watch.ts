import type { Buffer } from 'node:buffer';
import type { FastifyInstance } from 'fastify';
import {
  FileNotFoundError,
  NotADirectoryError,
  type WatchEvent,
} from '../../executor/executor';
import {
  connectError,
  envelope,
  FLAG_END_STREAM,
  FLAG_MESSAGE,
  readFirstMessage,
} from '../protocol';
import { WatcherLimitError } from '../watcher-table';
import {
  type EnvdContext,
  MAX_KEEPALIVE_SECONDS,
  rawWriter,
  sandboxIdOf,
  streamError,
  wireDeadlineMs,
} from './shared';

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

/** The watch faces: the streaming WatchDir plus the sync SDKs' polling trio. */
export function registerWatchRoutes(
  app: FastifyInstance,
  ctx: EnvdContext,
): void {
  const { executor, watchers } = ctx;

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
    const row = await ctx.wakeForStream(request, reply);
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
      watcher = await executor.watchDir(row.id, {
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
    const path = body.path;
    return ctx.inSlot(sandboxIdOf(request), async (row) => {
      try {
        const watcherId = await watchers.create({
          executor,
          sandboxId: row.id,
          path,
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
  });

  app.post('/filesystem.Filesystem/GetWatcherEvents', async (request) => {
    const body = request.body as { watcherId?: string };
    if (!body.watcherId) {
      throw connectError('invalid_argument', 'missing watcher id');
    }
    // No wake: this reads daemon memory. A frozen sandbox has no new events
    // to report anyway — the disk cannot change while it is frozen.
    const row = ctx.requireRunningRow(sandboxIdOf(request));
    const events = watchers.drain(row.id, body.watcherId);
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
    return ctx.withoutWake(sandboxIdOf(request), async (row) => {
      // A frozen watcher survives physically. Retire it in daemon memory now
      // and let the next real wake reap it; cleanup must not wake by itself.
      const removed =
        row.state === 'active'
          ? await watchers.remove(row.id, body.watcherId as string)
          : watchers.retire(row.id, body.watcherId as string);
      if (!removed) {
        throw connectError(
          'not_found',
          `watcher with id ${body.watcherId} not found`,
        );
      }
      return {};
    });
  });
}
