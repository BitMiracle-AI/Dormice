import { createGunzip } from 'node:zlib';
import { resolveSandboxPath } from '@dormice/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { touch } from '../../db/ledger';
import { startExecHeartbeat } from '../../exec-heartbeat';
import {
  DiskFullError,
  FileNotFoundError,
  NotAFileError,
  type SandboxEntry,
} from '../../executor/executor';
import { E2bError } from '../protocol';
import {
  type EnvdContext,
  sandboxIdOf,
  UNLIMITED_BODY_BYTES,
  vetUsername,
} from './shared';

/**
 * The plain-HTTP file faces: GET /files streams out, POST /files streams in.
 * The handler cores take the sandbox id as a parameter because two doors
 * lead here — the envd surface (id in the E2b-Sandbox-Id header, token
 * auth) and the signed-URL surface at the daemon root (id recovered from
 * the signature itself, no headers at all).
 */
export function registerFileRoutes(
  app: FastifyInstance,
  ctx: EnvdContext,
): void {
  app.get('/files', async (request, reply) =>
    serveFileDownload(ctx, sandboxIdOf(request), request, reply),
  );

  app.post('/files', { bodyLimit: UNLIMITED_BODY_BYTES }, (request, reply) =>
    serveFileUpload(ctx, sandboxIdOf(request), request, reply),
  );
}

export async function serveFileDownload(
  ctx: EnvdContext,
  sandboxId: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { db, executor } = ctx;
  const query = request.query as { path?: string; username?: string };
  if (!query.path) {
    throw new E2bError(400, 'invalid_argument', 'missing path query');
  }
  // Identity rides the username query on this face (the SDK's user option);
  // vetted before anything wakes.
  const user = vetUsername(query.username);
  const row = await ctx.wakeForUse(sandboxId);
  const stopHeartbeat = startExecHeartbeat(
    db,
    row.sandboxId,
    row.freezeAfterSeconds,
  );
  try {
    let entry: SandboxEntry;
    try {
      entry = await executor.statEntry(row.sandboxId, query.path, user);
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
    await executor.readFileStream(
      row.sandboxId,
      query.path,
      (chunk) => {
        if (!reply.raw.write(chunk)) {
          // Backpressure: the promise pauses the pipe all the way into the
          // container until the client drains.
          return new Promise<void>((resolve) =>
            reply.raw.once('drain', resolve),
          );
        }
      },
      user,
    );
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
}

export async function serveFileUpload(
  ctx: EnvdContext,
  sandboxId: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const { db, executor } = ctx;
  const query = request.query as { path?: string; username?: string };
  const user = vetUsername(query.username);
  const row = await ctx.wakeForUse(sandboxId);
  const stopHeartbeat = startExecHeartbeat(
    db,
    row.sandboxId,
    row.freezeAfterSeconds,
  );
  try {
    const written: Array<{ name: string; type: 'file'; path: string }> = [];
    const writeOne = async (path: string, content: NodeJS.ReadableStream) => {
      try {
        await executor.writeFileStream(row.sandboxId, path, content, user);
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
      // The SDK's gzip option is a Content-Encoding on the whole body (it
      // implies octet-stream). The sandbox must receive the decoded bytes —
      // storing the gzip framing is delivering a corrupted file (measured
      // 2026-07-10 under the Python SDK, whose write(gzip=True) uses this).
      let content = request.body as NodeJS.ReadableStream;
      if (request.headers['content-encoding'] === 'gzip') {
        const gunzip = createGunzip();
        content.pipe(gunzip);
        content = gunzip;
      }
      await writeOne(query.path, content);
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
}
