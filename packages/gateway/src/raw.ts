import http from 'node:http';
import type { Duplex } from 'node:stream';
import { ENVD_PORT } from '@dormice/shared';
import type { Logger } from 'pino';
import type { Classified } from './classify';
import {
  type Dialect,
  type RenderedError,
  relay,
  renderError,
  sendPreflight,
} from './errors';
import type { Finder, Found } from './find';
import { forwardStream, forwardUpgrade } from './forward';

export interface RawFacesDeps {
  finder: Finder;
  token: string;
  log: Logger;
}

/** How long a caller refused with "a node did not answer" may wait before asking again — one check-in interval. */
export const RETRY_AFTER_SECONDS = 15;

type ProxyFace = Extract<Classified, { face: 'proxy' }>;

/**
 * The faces Fastify never sees — keyed on a header on any path, judged on
 * the raw request the serverFactory hands over:
 *   proxy       the sandbox port proxy, keyed by the Host label (E2B's
 *               getHost() URL, classify.ts): the node holding the id is
 *               found and the request goes there whole — Host kept, since
 *               the node's own proxy keys on it and dials the container
 *               (and on 49983 /files its signed file door pins the sandbox
 *               by it), no credential added, since sandbox traffic is
 *               unauthenticated, as E2B's is: a preview URL exists to be
 *               opened by whoever it is shared with. The node wakes a
 *               frozen sandbox on traffic and answers "not listening" for
 *               a port nobody serves; the gateway adds only where it is.
 *               WebSocket upgrades ride the same way (forwardUpgrade).
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
 *
 * Each face's refusals wear that face's dialect (errors.ts): connect for
 * envd, and for the proxy the daemon's proxy answer — { message }, 502 —
 * so a caller reads one shape from either door.
 */
export function createRawFaces({ finder, token, log }: RawFacesDeps) {
  /** The one sentence per finding for a sandbox id on these faces — generic on purpose (above). */
  function sentence(
    id: string,
    found: Exclude<Found, { kind: 'one' }>,
  ): RenderedError {
    switch (found.kind) {
      case 'conflict':
        return {
          status: 502,
          connectCode: 'unavailable',
          message: `sandbox "${id}" is held by more than one node — routing resumes once an operator destroys one copy (listNodes and the gateway log name them)`,
        };
      case 'none':
        return {
          status: 502,
          connectCode: 'unavailable',
          message: `sandbox "${id}" is on no node — it may have been destroyed`,
        };
      case 'unsure':
        return {
          status: 503,
          connectCode: 'unavailable',
          message: `sandbox "${id}": a node did not answer, so its whereabouts cannot be settled — retry`,
          retryAfterSeconds: RETRY_AFTER_SECONDS,
        };
    }
  }

  /**
   * Finds the id, or answers the refusal and returns null. The lookup
   * itself failing (not a node's silence — the gateway's own bug) is a 500
   * that sends the operator to the log.
   */
  async function locate(
    res: http.ServerResponse,
    id: string,
    dialect: Dialect,
    cors: boolean,
    face: string,
  ): Promise<Extract<Found, { kind: 'one' }>> {
    let found: Found;
    try {
      found = await finder.byId(id);
    } catch (error) {
      log.error(error, `${face} face: the lookup itself failed`);
      renderError(res, dialect, {
        status: 500,
        message: 'the gateway failed while locating the sandbox — see its log',
        cors,
      });
      throw new Refused();
    }
    if (found.kind !== 'one') {
      renderError(res, dialect, { ...sentence(id, found), cors });
      throw new Refused();
    }
    return found;
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
    face: 'envd' | 'proxy',
    cors: boolean,
  ): Promise<void> {
    const dialect: Dialect = face === 'envd' ? 'connect' : 'native';
    let found: Extract<Found, { kind: 'one' }>;
    try {
      found = await locate(res, id, dialect, cors, face);
    } catch {
      return;
    }
    const node = found.node;
    await relay(
      res,
      dialect,
      log,
      async () => {
        await forwardStream(req, res, {
          target: { endpoint: node.endpoint, token },
          credential: 'none',
          preserveHost: face === 'proxy',
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
          `${face} face: the sandbox's node did not answer`,
        );
        return {
          status: 502,
          connectCode: 'unavailable',
          message: `sandbox "${id}": its node did not answer (${error.why}) — retry`,
          cors,
        };
      },
      cors,
    );
  }

  /**
   * The upgrade half of the proxy face: found the same way, then the
   * daemon's own replay (forwardUpgrade). A refusal is a bare status line
   * on the socket — there is no response object on an upgrade — in the
   * same words as the request half's.
   */
  async function upgrade(
    kind: ProxyFace,
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    let found: Found;
    try {
      found = await finder.byId(kind.sandboxId);
    } catch (error) {
      log.error(error, 'proxy face: the lookup itself failed (upgrade)');
      refuseUpgrade(socket, {
        status: 500,
        message: 'the gateway failed while locating the sandbox — see its log',
      });
      return;
    }
    // The client left while its sandbox was being found (a lookup round
    // is up to two seconds): nothing to dial the node for.
    if (socket.destroyed) return;
    if (found.kind !== 'one') {
      refuseUpgrade(socket, sentence(kind.sandboxId, found));
      return;
    }
    forwardUpgrade(req, socket, head, {
      endpoint: found.node.endpoint,
      token,
    });
  }

  return {
    handleRequest(
      kind: Exclude<Classified, { face: 'fastify' }>,
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ): void {
      switch (kind.face) {
        case 'proxy': {
          // The browser-direct file form (49983 /files, the daemon's
          // signed door) promises CORS on every answer, refusals included,
          // or the browser could not read them; the daemon's proxy answers
          // carry none, and neither do the gateway's for any other host.
          void route(
            req,
            res,
            kind.sandboxId,
            'proxy',
            browserDirect(kind, req),
          );
          return;
        }
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
          void route(req, res, id, 'envd', true);
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
      kind: Classified,
      req: http.IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ): void {
      // First, before anything else: http.Server drops its own error
      // listener from the socket before emitting 'upgrade', so a client
      // that resets here would raise an uncaught ECONNRESET and take the
      // whole gateway down — from an unauthenticated face (the daemon's
      // sandbox-proxy.ts handleUpgrade has the same first line).
      socket.on('error', () => socket.destroy());
      // Only the proxy face takes upgrades: sandbox WebSockets (a dev
      // server's HMR, a notebook). Everything else is cut, exactly as
      // stock Fastify, which never handles upgrades, would.
      if (kind.face !== 'proxy') {
        socket.destroy();
        return;
      }
      void upgrade(kind, req, socket, head);
    },
  };
}

/** Thrown inside route() once the refusal is on the wire — the signal to stop, never seen outside. */
class Refused extends Error {}

/** Is this the browser-postable signed-URL form, `49983-<id>.<domain>/files`? Path-only, query ignored — the daemon's own carve-out test. */
function browserDirect(kind: ProxyFace, req: http.IncomingMessage): boolean {
  if (kind.port !== ENVD_PORT) return false;
  const url = req.url ?? '';
  const q = url.indexOf('?');
  return (q === -1 ? url : url.slice(0, q)) === '/files';
}

/** A refusal on an upgrade: one status line and a JSON body, before any handshake was replayed (forwardUpgrade's own refusals have the same shape). */
function refuseUpgrade(socket: Duplex, error: RenderedError): void {
  if (socket.destroyed || socket.writableEnded) return;
  const body = JSON.stringify({ message: error.message });
  const retry =
    error.retryAfterSeconds === undefined
      ? ''
      : `retry-after: ${error.retryAfterSeconds}\r\n`;
  socket.end(
    `HTTP/1.1 ${error.status} ${http.STATUS_CODES[error.status] ?? ''}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n${retry}connection: close\r\n\r\n${body}`,
  );
}
