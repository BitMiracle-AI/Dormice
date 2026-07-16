import multipart from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { E2bDeps } from './deps';
import { serveFileDownload, serveFileUpload } from './envd/files';
import { createEnvdContext, UNLIMITED_BODY_BYTES } from './envd/shared';
import { E2bError } from './protocol';
import { findRowBySignature, type SigningOperation } from './signing';

/**
 * The signed-URL file surface, at the DAEMON ROOT — not under /e2b/envd.
 * Not a stylistic choice: the SDK's uploadUrl/downloadUrl build their URL
 * as `new URL('/files', sandboxUrl)`, and an absolute path replaces the
 * whole path — the /e2b/envd prefix is stripped (verified against the SDK
 * source). The consumer is a bare browser or curl: no E2b-Sandbox-Id
 * header, no token, nothing but the query. The signature alone
 * authenticates AND identifies the sandbox (see findRowBySignature).
 *
 * Deliberately signature-only: a header token here would be a second door
 * to the same room — token-authenticated file traffic already has
 * /e2b/envd/files. Real envd accepts both because it has only one door.
 */
export const signedFileRoutes: FastifyPluginAsyncZod<E2bDeps> = async (
  app,
  deps,
) => {
  // Same parser set as the envd surface: the upload shapes are identical.
  await app.register(multipart, {
    limits: {
      fileSize: UNLIMITED_BODY_BYTES,
      files: 1000,
      parts: 2000,
      fieldSize: 1024 * 1024,
    },
    preservePath: true,
  });
  app.addContentTypeParser(
    'application/octet-stream',
    (_request, payload, done) => done(null, payload),
  );

  // The envd error dialect ({ code: string, message }), scoped to these two
  // routes; the daemon root's native { message } dialect stays untouched —
  // and so does its 404 handler (no setNotFoundHandler here on purpose).
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof E2bError) {
      return reply
        .code(error.statusCode)
        .send({ code: error.code, message: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error, 'signed file request failed');
    }
    return reply.code(status).send({
      code: status === 400 ? 'invalid_argument' : 'internal',
      message: (error as Error).message,
    });
  });

  const ctx = createEnvdContext(deps);

  /**
   * Real envd's validateSigning, in its order: missing signature first,
   * then the constant-time match (which here also recovers the sandbox),
   * and only then the expiration — a wrong signature must never learn from
   * the error whether it was also expired.
   */
  function authenticate(request: FastifyRequest, operation: SigningOperation) {
    const query = request.query as {
      path?: string;
      username?: string;
      signature?: string;
      signature_expiration?: string;
    };
    if (!query.signature) {
      throw new E2bError(
        401,
        'unauthenticated',
        'missing signature query parameter',
      );
    }
    const expirationUnix =
      query.signature_expiration === undefined
        ? undefined
        : Number(query.signature_expiration);
    const row = findRowBySignature(
      deps.db,
      deps.envdSigningSecret,
      {
        path: query.path ?? '',
        operation,
        username: query.username ?? '',
        ...(expirationUnix === undefined ? {} : { expirationUnix }),
      },
      query.signature,
    );
    if (!row) {
      throw new E2bError(401, 'unauthenticated', 'invalid signature');
    }
    if (
      expirationUnix !== undefined &&
      expirationUnix < Math.floor(Date.now() / 1000)
    ) {
      throw new E2bError(
        401,
        'unauthenticated',
        'signature is already expired',
      );
    }
    // The signed username also names the execution identity; the file
    // handler cores vet it against the image's users (a tampered username
    // never gets that far — the signature covers it).
    return row;
  }

  app.get('/files', async (request, reply) => {
    const row = authenticate(request, 'read');
    return serveFileDownload(ctx, row.id, request, reply);
  });

  app.post('/files', { bodyLimit: UNLIMITED_BODY_BYTES }, (request, reply) => {
    const row = authenticate(request, 'write');
    return serveFileUpload(ctx, row.id, request, reply);
  });
};
