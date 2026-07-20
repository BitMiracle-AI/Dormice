import multipart from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { parseSandboxHost } from '../sandbox-proxy';
import { allowCorsOrigin, sendPreflight } from './cors';
import type { E2bDeps } from './deps';
import { serveFileDownload, serveFileUpload } from './envd/files';
import { createEnvdContext, UNLIMITED_BODY_BYTES } from './envd/shared';
import { E2bError } from './protocol';
import {
  authenticateSignedQuery,
  type SignedFileQuery,
  type SigningOperation,
} from './signing';

/**
 * The signed-URL file surface, at the DAEMON ROOT — not under /e2b/envd.
 * Not a stylistic choice: the SDK's uploadUrl/downloadUrl build their URL
 * as `new URL('/files', sandboxUrl)`, and an absolute path replaces the
 * whole path — the /e2b/envd prefix is stripped (verified against the SDK
 * source). The consumer is a bare browser or curl: no E2b-Sandbox-Id
 * header, no token, nothing but the query. The signature alone
 * authenticates AND identifies the sandbox (see authenticateSignedQuery).
 *
 * Two Host spellings land here, one door: the bare daemon origin (the URL
 * uploadUrl mints verbatim) and — with DORMICE_SANDBOX_DOMAIN set —
 * `49983-<sandboxId>.<domain>`, real E2B's browser-postable form, which
 * the sandbox proxy carves out of port forwarding (see ENVD_PORT). On the
 * subdomain form the Host label pins the sandbox: a signature minted for
 * any other sandbox is refused, exactly as each real envd only ever
 * accepts its own.
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

  // Browser-consumable means CORS-consumable: every response on this door,
  // refusals included, carries the wildcard origin (see cors.ts). The
  // hijacked download path writes its own head and re-states it there.
  app.addHook('onRequest', async (_request, reply) => {
    allowCorsOrigin(reply);
  });

  const ctx = createEnvdContext(deps);
  const domain = deps.config.DORMICE_SANDBOX_DOMAIN;

  /**
   * The signature check plus, on the subdomain form, the Host pin: which
   * sandbox the label names is which sandbox the signature must speak for.
   * The signed username also names the execution identity; the file
   * handler cores vet it against the image's users (a tampered username
   * never gets that far — the signature covers it).
   */
  function authenticate(
    request: FastifyRequest,
    operation: SigningOperation,
  ): string {
    const pinned = domain
      ? parseSandboxHost(request.headers.host, domain)?.sandboxId
      : undefined;
    return authenticateSignedQuery({
      db: deps.db,
      signingSecret: deps.envdSigningSecret,
      query: request.query as SignedFileQuery,
      operation,
      ...(pinned === undefined ? {} : { pinnedSandboxId: pinned }),
    });
  }

  // The preflight the whole browser flow hangs on — an XHR with
  // upload.onprogress always sends one, credential-less by spec.
  app.options('/files', async (request, reply) =>
    sendPreflight(request, reply),
  );

  app.get('/files', async (request, reply) => {
    const sandboxId = authenticate(request, 'read');
    return serveFileDownload(ctx, sandboxId, request, reply);
  });

  app.post('/files', { bodyLimit: UNLIMITED_BODY_BYTES }, (request, reply) => {
    const sandboxId = authenticate(request, 'write');
    return serveFileUpload(ctx, sandboxId, request, reply);
  });
};
