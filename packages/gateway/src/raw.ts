import http from 'node:http';
import type { Duplex } from 'node:stream';
import { isEnvdFilesForm } from '@dormice/shared';
import type { Logger } from 'pino';
import {
  type Classified,
  isOriginForm,
  ORIGIN_FORM_REQUIRED,
} from './classify';
import {
  type Dialect,
  type RenderedError,
  relay,
  renderError,
  sendPreflight,
} from './errors';
import type { Finder, Found } from './find';
import type { NodeState } from './fleet';
import { forwardStream, forwardUpgrade } from './forward';

export interface RawFacesDeps {
  finder: Finder;
  token: string;
  log: Logger;
}

/** How long a caller refused with "a node did not answer" may wait before asking again — one check-in interval. */
export const RETRY_AFTER_SECONDS = 15;

type ProxyFace = Extract<Classified, { face: 'proxy' }>;

/** What a keyed face learned of a sandbox id: the node to forward to, or the refusal to answer with. */
type Located = { node: NodeState } | { refusal: RenderedError };

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
 *               The one exception is the browser-direct file form's
 *               preflight, answered at the door (handleRequest below).
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
   * Finds the id, or the refusal to answer with — the one adjudication
   * both halves of a keyed face make, each writing a refusal in its own
   * medium (a response; a status line on an upgrade's socket). A value,
   * not an exception: the refusal is an answer, not a failure. The lookup
   * itself failing (not a node's silence — the gateway's own bug) is a
   * 500 that sends the operator to the log.
   */
  async function locate(id: string, what: string): Promise<Located> {
    let found: Found;
    try {
      found = await finder.byId(id);
    } catch (error) {
      log.error(error, `${what}: the lookup itself failed`);
      return {
        refusal: {
          status: 500,
          message:
            'the gateway failed while locating the sandbox — see its log',
        },
      };
    }
    return found.kind === 'one'
      ? { node: found.node }
      : { refusal: sentence(id, found) };
  }

  /**
   * Finds the id and forwards, or answers the refusal — the one path
   * every keyed face takes. Nothing here may throw: no framework stands
   * behind a raw face, so an escaped rejection would be the process's,
   * not the request's (errors.ts relay answers instead).
   */
  async function route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    face: 'envd' | 'proxy',
    cors: boolean,
  ): Promise<void> {
    const dialect: Dialect = face === 'envd' ? 'connect' : 'native';
    const located = await locate(id, `${face} face`);
    if ('refusal' in located) {
      renderError(res, dialect, { ...located.refusal, cors });
      return;
    }
    const { node } = located;
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
    const located = await locate(kind.sandboxId, 'proxy face (upgrade)');
    // The client left while its sandbox was being found (a lookup round
    // is up to two seconds): nothing to dial the node for.
    if (socket.destroyed) return;
    if ('refusal' in located) {
      refuseUpgrade(socket, located.refusal);
      return;
    }
    forwardUpgrade(req, socket, head, {
      endpoint: located.node.endpoint,
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
          // Its preflight is answered here, as the envd face's is: a
          // preflight is credential-less and asks nothing of the sandbox,
          // and the node would answer it in this very shape (its cors.ts).
          // Forwarded instead, an id on no node earned it the 502 below —
          // which no browser reads on a preflight: it drops the real
          // request, and the readable refusal is never seen (found by
          // review, 2026-09-14). Every other sandbox host's OPTIONS is the
          // sandbox's own: the app inside decides its CORS.
          const direct = isEnvdFilesForm(kind.port, req.url);
          if (direct && req.method === 'OPTIONS') {
            sendPreflight(req, res);
            return;
          }
          void route(req, res, kind.sandboxId, 'proxy', direct);
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
      // The request path's first rule (classify.ts isOriginForm), in this
      // path's medium — a status line, there being no response object.
      // Judged ahead of the face: an absolute-form handshake on a sandbox
      // host was replayed into the sandbox verbatim, the gateway and the
      // node reading two different requests (found by review, 2026-09-14,
      // reproduced on the test machine).
      if (!isOriginForm(req)) {
        refuseUpgrade(socket, { status: 400, message: ORIGIN_FORM_REQUIRED });
        return;
      }
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
