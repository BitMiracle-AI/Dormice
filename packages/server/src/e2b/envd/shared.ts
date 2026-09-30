import { Buffer } from 'node:buffer';
import type { ServerResponse } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { findById, touch } from '../../db/ledger';
import type { SandboxRow } from '../../db/schema';
import {
  DiskFullError,
  FileNotFoundError,
  NotADirectoryError,
  NotAFileError,
} from '../../executor/executor';
import { wakeSandbox } from '../../lifecycle';
import type { E2bDeps } from '../deps';
import { connectError, E2bError, envelope, FLAG_END_STREAM } from '../protocol';
import { e2bView } from '../view';

/**
 * In-container cleanup backstop for e2b-surface processes. Deliberately not
 * the wire deadline: connect-timeout-ms only ever closes the stream — the
 * process lives until it exits, is signaled, or its sandbox dies (E2B's
 * semantics; the native /execCommand keeps its own kill-at-timeout contract).
 */
export const MAX_EXEC_SECONDS = 24 * 60 * 60;

/** The SDK asks for keepalives via this header; we honor it, capped. */
export const MAX_KEEPALIVE_SECONDS = 30;

/** Effectively unbounded route body: the disk quota is the real gate. */
export const UNLIMITED_BODY_BYTES = Number.MAX_SAFE_INTEGER;

/** Executor file errors -> the Connect codes the SDK maps back to its own taxonomy. */
export function toConnectError(error: unknown): unknown {
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

/** Every envd request names its sandbox in this header. */
export function sandboxIdOf(request: FastifyRequest): string {
  const header = request.headers['e2b-sandbox-id'];
  const id = Array.isArray(header) ? header[0] : header;
  if (!id) {
    throw new E2bError(401, 'unauthenticated', 'missing E2b-Sandbox-Id header');
  }
  return id;
}

/**
 * The SDK's `user` option travels as `Authorization: Basic base64("<u>:")`
 * — username, empty password (real envd's authenticate.go reads BasicAuth
 * the same way). Absent (the SDK sends nothing against envd >= 0.4.0, which
 * we report) means the default user.
 */
export function usernameOf(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Basic ')) return undefined;
  const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const username = colon === -1 ? decoded : decoded.slice(0, colon);
  return username || undefined;
}

/**
 * The single arbiter of which usernames exist: the base image has exactly
 * `user` (uid 1000) and `root` — a deliberate narrowing of real envd's
 * "any system user" (documented in the protocol rules). The message is real
 * envd's own wording for an unknown user.
 */
export function vetUsername(name: string | undefined): string | undefined {
  if (name === undefined || name === 'user' || name === 'root') return name;
  throw connectError('unauthenticated', `invalid username: '${name}'`);
}

/** The SDK's connect-timeout-ms header, absent meaning "effectively never". */
export function wireDeadlineMs(request: FastifyRequest): number {
  const headerMs = Number(request.headers['connect-timeout-ms']);
  return Number.isFinite(headerMs) && headerMs > 0
    ? headerMs
    : MAX_EXEC_SECONDS * 1000;
}

/**
 * How long a client may take no byte of a response stream before it is
 * taken for gone. Every stream here is delivered at the client's pace all
 * the way back into the sandbox (docker-streams.ts), so a client that
 * stops reading without hanging up — its TCP window at zero, the socket
 * otherwise healthy — holds what is behind its stream: the command blocked
 * on its output, and with it every other client of that process (the
 * process table waits for its slowest reader), or the watcher behind a
 * watch. Beijing, 2026-09-28: a caller held ten responses open unread, the
 * oldest for 37 hours. The clock runs only while a write waits, and any
 * progress restarts it — nginx's send_timeout, same reading.
 *
 * Five minutes, not nginx's one: the silence is measured at the daemon's
 * own socket, a hop or two before the client, and every hop on the host
 * (the gateway, Caddy) is a loopback socket whose buffers grow to
 * megabytes and are let go a third at a time — a client taking a steady
 * 10 KB/s shows here as minutes of silence between bursts (measured
 * 2026-09-30: a 64 MiB download at 10 KB/s was taken for gone at 61s
 * under the 60s this once was, one at 100 KB/s served). Five minutes
 * serves a client down to about 5 KB/s. dockerd's stake in a stopped
 * reader — an exec whose end waits on its unread output — is not settled
 * here but where it arises (OutputDelivery in executor/docker-streams.ts).
 */
export const CLIENT_STALL_SECONDS = 300;

/**
 * Writes one chunk of a response stream and settles once the client has
 * it — 'taken' — or never will: 'gone' when the connection closed,
 * 'stalled' when it took nothing for CLIENT_STALL_SECONDS, in which case
 * the connection is destroyed here and every face's own gone-client path
 * takes over. The one place the daemon waits on a client.
 */
export function writeToClient(
  res: ServerResponse,
  chunk: Buffer,
  stallMs = CLIENT_STALL_SECONDS * 1000,
): Promise<'taken' | 'gone' | 'stalled'> {
  return new Promise((resolve) => {
    if (res.destroyed) return resolve('gone');
    if (res.write(chunk)) return resolve('taken');
    // destroy() flips .destroyed before 'close' is emitted — a listener
    // attached after the fact would wait forever.
    if (res.destroyed) return resolve('gone');
    const settle = (outcome: 'taken' | 'gone' | 'stalled') => {
      clearTimeout(timer);
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(outcome);
    };
    const onDrain = () => settle('taken');
    const onClose = () => settle('gone');
    const timer = setTimeout(() => {
      settle('stalled');
      res.destroy();
    }, stallMs);
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

/**
 * The raw write every process and watch stream shares. A client gone — or
 * stalled, which writeToClient makes gone — resolves at once and the frame
 * is dropped: that is what a closed connection means. The process itself
 * deliberately keeps running: E2B semantics, a watcher's disconnect is not
 * a kill (the SDK reconnects to the same pid).
 */
export function rawWriter(reply: FastifyReply): (buf: Buffer) => Promise<void> {
  return async (buf) => {
    if ((await writeToClient(reply.raw, buf)) === 'stalled') {
      reply.log.info(
        `client took no byte for ${CLIENT_STALL_SECONDS}s — its stream is closed`,
      );
    }
  };
}

/** Streaming endpoints answer errors inside the stream: 200 + end-stream frame. */
export function streamError(
  reply: FastifyReply,
  code: string,
  message: string,
): void {
  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'application/connect+json' });
  reply.raw.write(envelope(FLAG_END_STREAM, { error: { code, message } }));
  reply.raw.end();
}

/**
 * The deps plus the liveness/wake adjudicators every envd face shares.
 * Built once per plugin registration; the route files receive it instead
 * of closing over the plugin body.
 */
export interface EnvdContext extends E2bDeps {
  /** The protocol-liveness gate: only a logically-running sandbox serves envd traffic. */
  requireRunningRow(sandboxId: string): SandboxRow;
  /** Current ledger state says the container can receive a cleanup signal. */
  isRunnable(sandboxId: string): boolean;
  /** Wake under the key's slot, like every native verb. */
  wakeForUse(sandboxId: string): Promise<SandboxRow>;
  /** Unary filesystem RPCs run entirely in the key's slot, like native file verbs. */
  inSlot<T>(
    sandboxId: string,
    work: (row: SandboxRow) => Promise<T>,
  ): Promise<T>;
  /** Serializes daemon-memory work without waking or touching the sandbox. */
  withoutWake<T>(
    sandboxId: string,
    work: (row: SandboxRow) => Promise<T>,
  ): Promise<T>;
  /** Wake-for-use with streaming-dialect errors: streamError, not thrown JSON. */
  wakeForStream(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SandboxRow | undefined>;
}

export function createEnvdContext(deps: E2bDeps): EnvdContext {
  const { db, executor, locks, archiver } = deps;

  /**
   * The archive detour, taken before any wake: E2B has no restoring
   * concept, so this surface blocks until the sandbox is back — resuming
   * an archived sandbox just takes longer. Joined OUTSIDE the key slot
   * (the restore task's own finish needs it). No-op for anything that is
   * not archived/restoring.
   */
  async function joinRestore(sandboxId: string): Promise<void> {
    if (archiver?.enabled()) {
      try {
        await archiver.restoreJoin(sandboxId);
      } catch (error) {
        throw new E2bError(
          502,
          'unavailable',
          `restoring the sandbox failed: ${error instanceof Error ? error.message : String(error)} — retry`,
        );
      }
      return;
    }
    const row = findById(db, sandboxId);
    if (row && (row.state === 'archived' || row.state === 'restoring')) {
      throw new E2bError(
        502,
        'unavailable',
        'sandbox is archived and no S3 archive store is configured',
      );
    }
  }

  /**
   * Only a logically-running sandbox serves envd traffic: paused and dead
   * answer 502, which the SDK triages into its "sandbox timed out / not
   * running" errors — exactly what talking to a paused or killed E2B
   * sandbox feels like.
   */
  function requireRunningRow(sandboxId: string): SandboxRow {
    const row = findById(db, sandboxId);
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
   * take seconds and must not race the scanner or a destroy.
   */
  function isRunnable(sandboxId: string): boolean {
    return findById(db, sandboxId)?.state === 'active';
  }

  async function wakeForUse(sandboxId: string): Promise<SandboxRow> {
    // The logical gate first: a paused-by-deadline sandbox answers 502
    // whether it is frozen or archived — restoring it for a request that
    // will be refused anyway would waste a whole restore.
    const before = requireRunningRow(sandboxId);
    await joinRestore(sandboxId);
    return locks.run(before.name, async () => {
      const fresh = requireRunningRow(sandboxId);
      const awake = await wakeSandbox(db, executor, fresh, deps.watchers);
      return touch(db, awake.id);
    });
  }

  async function inSlot<T>(
    sandboxId: string,
    work: (row: SandboxRow) => Promise<T>,
  ): Promise<T> {
    const before = requireRunningRow(sandboxId);
    await joinRestore(sandboxId);
    return locks.run(before.name, async () => {
      const fresh = requireRunningRow(sandboxId);
      const awake = await wakeSandbox(db, executor, fresh, deps.watchers);
      const row = touch(db, awake.id);
      try {
        return await work(row);
      } catch (error) {
        throw toConnectError(error);
      }
    });
  }

  async function withoutWake<T>(
    sandboxId: string,
    work: (row: SandboxRow) => Promise<T>,
  ): Promise<T> {
    const before = findById(db, sandboxId);
    if (!before) {
      throw new E2bError(502, 'unavailable', 'sandbox not found');
    }
    return locks.run(before.name, async () => {
      const fresh = findById(db, sandboxId);
      if (!fresh) {
        throw new E2bError(502, 'unavailable', 'sandbox not found');
      }
      try {
        return await work(fresh);
      } catch (error) {
        throw toConnectError(error);
      }
    });
  }

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

  return {
    ...deps,
    requireRunningRow,
    isRunnable,
    wakeForUse,
    inSlot,
    withoutWake,
    wakeForStream,
  };
}
