import type http from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from 'pino';
import type { Classified } from './classify';
import { relay, renderError, sendPreflight } from './errors';
import type { Finder, Found } from './find';
import { forwardStream } from './forward';

export interface RawFacesDeps {
  finder: Finder;
  token: string;
  log: Logger;
}

/** How long a caller refused with "a node did not answer" may wait before asking again — one check-in interval. */
export const RETRY_AFTER_SECONDS = 15;

/**
 * The faces Fastify never sees — keyed on a header on any path, judged on
 * the raw request the serverFactory hands over:
 *   envd        E2B's in-sandbox API, keyed by E2b-Sandbox-Id; forwarded
 *               with no credential change (the access token is the node's
 *               own HMAC). Preflights are answered here: the node answers
 *               them without auth, and a preflight that came back 401
 *               without CORS would fail every browser-direct upload.
 *   signedRoot  the bare signed-URL form: no sandbox id anywhere the
 *               gateway can read without the node's signing secret, so an
 *               honest 501.
 *
 * Nobody has authenticated to the gateway on these faces — the node
 * judges the credential, after the gateway has picked it — so what the
 * gateway says here describes the sandbox's state and never the fleet: no
 * node id, no endpoint. A sandbox id is handed to browsers in every
 * getHost URL, and the daemon's own proxy says only "not found" for one
 * it lacks. The detail an operator needs goes to the log; the
 * authenticated faces and listNodes name nodes freely.
 */
export function createRawFaces({ finder, token, log }: RawFacesDeps) {
  /** The one sentence per finding for a sandbox id on these faces — generic on purpose (above). */
  function refusal(
    res: http.ServerResponse,
    id: string,
    found: Exclude<Found, { kind: 'one' }>,
  ): void {
    switch (found.kind) {
      case 'conflict':
        renderError(res, 'connect', {
          status: 502,
          connectCode: 'unavailable',
          message: `sandbox "${id}" is held by more than one node — routing resumes once an operator destroys one copy (listNodes and the gateway log name them)`,
          cors: true,
        });
        return;
      case 'none':
        renderError(res, 'connect', {
          status: 502,
          connectCode: 'unavailable',
          message: `sandbox "${id}" is on no node — it may have been destroyed`,
          cors: true,
        });
        return;
      case 'unsure':
        renderError(res, 'connect', {
          status: 503,
          connectCode: 'unavailable',
          message: `sandbox "${id}": a node did not answer, so its whereabouts cannot be settled — retry`,
          cors: true,
          retryAfterSeconds: RETRY_AFTER_SECONDS,
        });
        return;
    }
  }

  /**
   * Finds the id and forwards, or answers the refusal — the one path
   * every keyed face takes. Nothing here may throw past this point: no
   * framework stands behind a raw face, so an escaped rejection would be
   * the process's, not the request's (errors.ts relay answers instead).
   */
  async function route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
  ): Promise<void> {
    let found: Found;
    try {
      found = await finder.byId(id);
    } catch (error) {
      log.error(error, 'envd face: the lookup itself failed');
      renderError(res, 'connect', {
        status: 500,
        connectCode: 'internal',
        message: 'the gateway failed while locating the sandbox — see its log',
        cors: true,
      });
      return;
    }
    if (found.kind !== 'one') {
      refusal(res, id, found);
      return;
    }
    const node = found.node;
    await relay(
      res,
      'connect',
      log,
      async () => {
        await forwardStream(req, res, {
          target: { endpoint: node.endpoint, token },
          credential: 'none',
        });
      },
      (error) => {
        log.warn(
          {
            sandboxId: id,
            nodeId: node.id,
            endpoint: node.endpoint,
            why: error.why,
          },
          "envd face: the sandbox's node did not answer",
        );
        return {
          status: 502,
          connectCode: 'unavailable',
          message: `sandbox "${id}": its node did not answer (${error.why}) — retry`,
          cors: true,
        };
      },
    );
  }

  return {
    handleRequest(
      kind: Exclude<Classified, { face: 'fastify' }>,
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ): void {
      switch (kind.face) {
        case 'envd': {
          if (req.method === 'OPTIONS') {
            sendPreflight(req, res);
            return;
          }
          const header = req.headers['e2b-sandbox-id'];
          const id = Array.isArray(header) ? header[0] : header;
          if (!id) {
            renderError(res, 'connect', {
              status: 401,
              connectCode: 'unauthenticated',
              message: 'missing E2b-Sandbox-Id header',
              cors: true,
            });
            return;
          }
          void route(req, res, id);
          return;
        }
        case 'signedRoot': {
          if (req.method === 'OPTIONS') {
            sendPreflight(req, res);
            return;
          }
          renderError(res, 'connect', {
            status: 501,
            connectCode: 'unimplemented',
            message:
              'the bare signed-URL form is not routed by the gateway yet — use the sandbox host form, or the node directly',
            cors: true,
          });
          return;
        }
      }
    },

    handleUpgrade(
      _kind: Classified,
      _req: http.IncomingMessage,
      socket: Duplex,
    ): void {
      // First, before anything else: http.Server drops its own error
      // listener from the socket before emitting 'upgrade', so a client
      // that resets here would raise an uncaught ECONNRESET and take the
      // whole gateway down — from an unauthenticated face (the daemon's
      // sandbox-proxy.ts handleUpgrade has the same first line).
      socket.on('error', () => socket.destroy());
      // No face of this build takes upgrades: sandbox WebSockets ride the
      // port proxy, which joins the gateway with the sandbox domain.
      socket.destroy();
    },
  };
}
