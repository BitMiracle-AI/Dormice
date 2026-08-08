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
import { EXPOSED_FILE_HEADERS, sendPreflight } from '../cors';
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
  // The browser preflight (see cors.ts); the auth hook waves OPTIONS
  // through — preflights are credential-less by spec.
  app.options('/files', async (request, reply) =>
    sendPreflight(request, reply),
  );

  app.get('/files', async (request, reply) =>
    serveFileDownload(ctx, sandboxIdOf(request), request, reply),
  );

  app.post('/files', { bodyLimit: UNLIMITED_BODY_BYTES }, (request, reply) =>
    serveFileUpload(ctx, sandboxIdOf(request), request, reply),
  );
}

/**
 * Extension → MIME for the download face. Real envd serves the true type
 * (Go's mime.TypeByExtension) plus a content-disposition filename; a bare
 * octet-stream breaks consumers that read the type from headers — the
 * signed URL keeps the path in the query, so Microsoft's Office online
 * viewer sees neither a path extension nor a usable header and rejects
 * docx/xlsx/pptx at preflight (A/B-measured against real envd 2026-07-18:
 * these two headers alone flip the verdict). Unknown extensions honestly
 * fall back to octet-stream.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  xml: 'text/xml; charset=utf-8',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  wasm: 'application/wasm',
};

function contentTypeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/**
 * RFC 5987 ext-value for the content-disposition filename.
 * encodeURIComponent leaves `'()*` bare, but they are not attr-chars.
 */
function rfc5987(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The client hung up mid-transfer — a canceled download, a closed tab.
 * Thrown into the executor's pump to stop the read; distinguished in the
 * catch because it is the client's own choice, not a daemon failure:
 * logging it as an error would bury the real mid-stream breaks (the
 * signal the 2026-08-08 truncation hunt ran on) under routine noise.
 */
class ClientGoneError extends Error {}

/**
 * How long a finished download's socket may keep draining the kernel
 * buffer toward a slow client before the idle reaper takes it (see the
 * end-of-stream comment in serveFileDownload). Ten minutes covers even a
 * dial-up-grade client emptying the largest plausible kernel backlog
 * (~10 MB at 20 KB/s ≈ 500 s); a healthy client closes long before.
 */
const DOWNLOAD_DRAIN_GRACE_MS = 10 * 60 * 1000;

type ParsedRange =
  | { kind: 'full' }
  | { kind: 'unsatisfiable' }
  | { kind: 'slice'; offset: number; end: number; length: number };

/**
 * One byte-range spec against a known size — what a video player actually
 * sends (an mp4's tail-of-file moov probe, a seek, Safari's opening
 * `bytes=0-1`). Multi-range, foreign units, and malformed specs are
 * lawfully ignored (RFC 9110 §14.2: Range is a request *modifier*) — the
 * full 200 is always a correct answer, so nothing here ever guesses.
 * A spec that names only bytes past EOF is the one hard refusal: 416,
 * because serving the full file for it would loop a naive resumer forever.
 */
function parseRangeHeader(
  header: string | string[] | undefined,
  size: number,
): ParsedRange {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match || (match[1] === '' && match[2] === '')) return { kind: 'full' };
  if (match[1] === '') {
    // Suffix form: the last N bytes — the moov-atom fetch.
    const n = Number(match[2]);
    if (n === 0 || size === 0) return { kind: 'unsatisfiable' };
    const offset = Math.max(0, size - n);
    return { kind: 'slice', offset, end: size - 1, length: size - offset };
  }
  const offset = Number(match[1]);
  if (offset >= size) return { kind: 'unsatisfiable' };
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (end < offset) return { kind: 'full' };
  return { kind: 'slice', offset, end, length: end - offset + 1 };
}

export async function serveFileDownload(
  ctx: EnvdContext,
  sandboxId: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const { db, executor } = ctx;
  const query = request.query as {
    path?: string;
    username?: string;
    download?: string;
  };
  if (!query.path) {
    throw new E2bError(400, 'invalid_argument', 'missing path query');
  }
  // download=1/true flips the disposition to attachment: a browser
  // NAVIGATING to the URL then saves instead of renders — the download
  // manager streams to disk with progress and (via Range) resume, which a
  // fetch-into-memory consumer can never offer for GB-sized files
  // (clawsgo's ask, 2026-07-31). Deliberately OUTSIDE the signature: the
  // signing material is pinned to real envd's getSignature, so admitting a
  // param would force SDK consumers to hand-roll signatures. Safe anyway —
  // the URL holder already has full read; attachment is strictly MORE
  // inert than inline (nothing renders on the sandbox origin), and
  // stripping the param merely restores today's default. Anything but the
  // two literal spellings keeps inline: the default must be untippable by
  // garbage, because media previews and Office viewers depend on it.
  const disposition =
    query.download === '1' || query.download === 'true'
      ? 'attachment'
      : 'inline';
  // Identity rides the username query on this face (the SDK's user option);
  // vetted before anything wakes.
  const user = vetUsername(query.username);
  const row = await ctx.wakeForUse(sandboxId);
  const stopHeartbeat = startExecHeartbeat(db, row.id, row.freezeAfterSeconds);
  try {
    let entry: SandboxEntry;
    try {
      entry = await executor.statEntry(row.id, query.path, user);
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
    const size = entry.sizeBytes;
    const range = parseRangeHeader(request.headers.range, size);
    if (range.kind === 'unsatisfiable') {
      // Pre-hijack, so this rides the normal reply (the surface's CORS
      // hook already stamped it); content-range names the real size —
      // that is how a ranging client recovers.
      return reply
        .code(416)
        .header('accept-ranges', 'bytes')
        .header('content-range', `bytes */${size}`)
        .send({
          code: 'invalid_argument',
          message: `range not satisfiable for a ${size}-byte file`,
        });
    }
    const slice = range.kind === 'slice' ? range : undefined;
    // Size first, then stream: the SDK needs content-length (an empty
    // file is detected by `content-length: 0`), and nothing buffers here.
    reply.hijack();
    reply.raw.writeHead(slice ? 206 : 200, {
      'content-type': contentTypeOf(entry.name),
      'content-disposition': `${disposition}; filename*=utf-8''${rfc5987(entry.name)}`,
      'content-length': String(slice ? slice.length : size),
      'last-modified': new Date(entry.modifiedTime).toUTCString(),
      // Real envd's promise, now kept: ranges are honored (video playback
      // and download resume are impossible without them), so advertising
      // them is the truth.
      'accept-ranges': 'bytes',
      ...(slice
        ? { 'content-range': `bytes ${slice.offset}-${slice.end}/${size}` }
        : {}),
      // The hijacked head bypasses reply.header(), so the CORS promise
      // (cors.ts: every file-face response is browser-readable) is
      // re-stated here.
      'access-control-allow-origin': '*',
      'access-control-expose-headers': EXPOSED_FILE_HEADERS,
    });
    await executor.readFileStream(
      row.id,
      query.path,
      (chunk) => {
        // With delivery-gated exec completion (docker.ts), a wait that can
        // never end would hold the transfer and its exec forever — and a
        // closed socket's 'drain' never fires. So a gone client aborts the
        // stream instead: the throw travels up through the executor's pump,
        // which destroys the exec stream, and lands in the catch below.
        if (reply.raw.destroyed) {
          throw new ClientGoneError('client disconnected mid-download');
        }
        if (!reply.raw.write(chunk)) {
          // Backpressure: the promise pauses the pipe all the way into the
          // container until the client drains — or is gone.
          return new Promise<void>((resolve, reject) => {
            const settle = (err?: Error) => {
              reply.raw.off('drain', onDrain);
              reply.raw.off('close', onClose);
              if (err) reject(err);
              else resolve();
            };
            const onDrain = () => settle();
            const onClose = () =>
              settle(new ClientGoneError('client disconnected mid-download'));
            // destroy() flips .destroyed before 'close' is emitted — a
            // listener attached after the fact would wait forever.
            if (reply.raw.destroyed) return onClose();
            reply.raw.once('drain', onDrain);
            reply.raw.once('close', onClose);
          });
        }
      },
      user,
      slice ? { offset: slice.offset, length: slice.length } : undefined,
    );
    // 'finish' (end's callback) means handed to the KERNEL, not received:
    // the kernel socket buffer absorbs megabytes past our 'drain'-paced
    // writes (loopback especially), and a slow client is still catching up
    // when we get here. Whoever destroys the socket now orphans that tail
    // — and Linux deliberately kills orphaned sockets facing a zero-window
    // reader in ~30s, RST-ing the last bytes away (measured 2026-08-08 on
    // the test host: 8 MB at 200 KB/s arrived 32-96 KB short; announcing
    // `connection: close` only moved the destroy earlier via destroySoon).
    // So: no close announcement (keep-alive keeps the fd open), and the
    // idle timer the server arms at 'finish' (keepAliveTimeout, single-
    // digit seconds) is re-armed to a drain grace long enough for any
    // realistic client to finish reading. The client's own close is what
    // ends the connection; the grace only reaps clients that stopped
    // reading forever. Our listener runs after the server's own 'finish'
    // handling (attach order), so the override sticks.
    // Listen, then end — not end(callback): inject()'s mock end() treats a
    // function first-arg as body data. The server's own 'finish' listener
    // predates ours (attached at request start), so ours re-arms last.
    const flushed = new Promise<void>((resolve) => {
      reply.raw.once('finish', resolve);
    });
    reply.raw.end();
    await flushed;
    // Optional call: app.inject()'s mock response has no real socket.
    reply.raw.socket?.setTimeout?.(DOWNLOAD_DRAIN_GRACE_MS);
  } catch (error) {
    if (reply.raw.headersSent) {
      // Mid-stream failure: the body length will not match the announced
      // content-length — the client sees a broken transfer, honestly.
      // A client that hung up on its own is routine, not an error.
      if (error instanceof ClientGoneError) {
        request.log.info('file download canceled by the client');
      } else {
        request.log.error(error, 'file download broke mid-stream');
      }
      reply.raw.destroy();
      return;
    }
    throw error;
  } finally {
    stopHeartbeat();
    try {
      touch(db, row.id);
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
  const stopHeartbeat = startExecHeartbeat(db, row.id, row.freezeAfterSeconds);
  try {
    const written: Array<{ name: string; type: 'file'; path: string }> = [];
    const writeOne = async (path: string, content: NodeJS.ReadableStream) => {
      try {
        await executor.writeFileStream(row.id, path, content, user);
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
      touch(db, row.id);
    } catch {
      // Released mid-upload; the upload's own result tells the story.
    }
  }
}
