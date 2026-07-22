import type { Buffer } from 'node:buffer';
import type { FastifyInstance, FastifyRequest } from 'fastify';
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
import {
  WatcherLimitError,
  WatcherOperationConflictError,
  WatcherOperationLimitError,
} from '../watcher-table';
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

export const WATCHER_OPERATION_HEADER = 'x-dormice-watcher-operation-id';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function operationIdOf(request: FastifyRequest): string | undefined {
  const header = request.headers[WATCHER_OPERATION_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (!UUID.test(normalized)) {
    throw connectError(
      'invalid_argument',
      `${WATCHER_OPERATION_HEADER} must be a UUID`,
    );
  }
  return normalized;
}

function watcherIdOf(body: { watcherId?: string }): string {
  if (!body.watcherId) {
    throw connectError('invalid_argument', 'missing watcher id');
  }
  if (!UUID.test(body.watcherId)) {
    throw connectError('invalid_argument', 'watcher id must be a UUID');
  }
  return body.watcherId.toLowerCase();
}

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
    const sandboxId = sandboxIdOf(request);
    let reservationId: string;
    try {
      reservationId = watchers.reserveStreaming(sandboxId);
    } catch (error) {
      if (error instanceof WatcherLimitError) {
        return streamError(reply, 'resource_exhausted', error.message);
      }
      throw error;
    }
    let row: Awaited<ReturnType<typeof ctx.wakeForStream>>;
    try {
      row = await ctx.wakeForStream(request, reply);
    } catch (error) {
      watchers.cancelStreamingReservation(sandboxId, reservationId);
      throw error;
    }
    if (!row) {
      watchers.cancelStreamingReservation(sandboxId, reservationId);
      return;
    }

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
    let watcherId: string;
    try {
      watcherId = await watchers.createStreaming({
        executor,
        sandboxId: row.id,
        reservationId,
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
      if (error instanceof WatcherLimitError) {
        return streamError(reply, 'resource_exhausted', error.message);
      }
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
        await watchers.closeStreaming(row.id, watcherId, {
          runnable: ctx.isRunnable(row.id),
        });
      } catch (error) {
        request.log.warn(error, 'streaming watcher cleanup deferred');
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
    const operationId = operationIdOf(request);
    return ctx.inSlot(sandboxIdOf(request), async (row) => {
      try {
        const watcherId = await watchers.create({
          executor,
          sandboxId: row.id,
          path,
          recursive: body.recursive === true,
          operationId,
        });
        return { watcherId };
      } catch (error) {
        if (
          error instanceof WatcherLimitError ||
          error instanceof WatcherOperationLimitError
        ) {
          throw connectError('resource_exhausted', error.message);
        }
        if (error instanceof WatcherOperationConflictError) {
          throw connectError('already_exists', error.message);
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
    const watcherId = watcherIdOf(request.body as { watcherId?: string });
    return ctx.withoutWake(sandboxIdOf(request), async (row) => {
      // The verb expresses the goal "this ID is absent from this sandbox".
      // Unknown and cross-sandbox IDs already satisfy it and deliberately look
      // alike. Only a physically active sandbox can accept a signal now; every
      // colder or protocol-dead state retires in memory without waking.
      await watchers.removeGoal(row.id, watcherId, {
        runnable: row.state === 'active',
      });
      return {};
    });
  });
}
