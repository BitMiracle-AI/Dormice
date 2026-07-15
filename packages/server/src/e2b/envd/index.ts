import multipart from '@fastify/multipart';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { findBySandboxId } from '../../db/ledger';
import type { E2bDeps } from '../deps';
import { E2bError, verifyEnvdToken } from '../protocol';
import { e2bView } from '../view';
import { registerFileRoutes } from './files';
import { registerFilesystemRoutes } from './filesystem';
import { registerProcessRoutes } from './process';
import { createEnvdContext, sandboxIdOf, UNLIMITED_BODY_BYTES } from './shared';
import { registerWatchRoutes } from './watch';

/**
 * The envd surface: what the official SDK reaches through its `sandboxUrl`
 * option. One origin serves every sandbox — the SDK attaches an
 * E2b-Sandbox-Id header to every request, so no wildcard DNS is needed.
 * Connect RPC rides the JSON codec (the SDK sets useBinaryFormat: false);
 * files ride plain HTTP. The daemon itself plays the role of envd — there
 * is no agent inside the container.
 *
 * This file owns the surface-wide machinery (parsers, auth, error dialect,
 * /health); each protocol face lives in its own route file.
 */
export const e2bEnvdRoutes: FastifyPluginAsyncZod<E2bDeps> = async (
  app,
  deps,
) => {
  const { db } = deps;
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

  // Auth: X-Access-Token must be the HMAC minted for exactly this sandbox.
  // /health stays open like real envd's — it is how isRunning() probes.
  app.addHook('onRequest', async (request) => {
    if (request.method === 'GET' && request.url.endsWith('/health')) return;
    const sandboxId = sandboxIdOf(request);
    const header = request.headers['x-access-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token || !verifyEnvdToken(deps.envdSigningSecret, sandboxId, token)) {
      throw new E2bError(401, 'unauthenticated', 'invalid envd access token');
    }
  });

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

  const ctx = createEnvdContext(deps);
  registerFileRoutes(app, ctx);
  registerFilesystemRoutes(app, ctx);
  registerWatchRoutes(app, ctx);
  registerProcessRoutes(app, ctx);
};
