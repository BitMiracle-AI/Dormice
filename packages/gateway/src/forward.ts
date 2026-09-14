import type http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Agent } from 'undici';
import { causeOf } from './lookup';

/**
 * The one place the gateway talks to a node on a caller's behalf. Bytes
 * in, bytes out: the request body is streamed (or handed over as the
 * buffer Fastify already read), the response is written head-first and
 * piped — never buffered, never re-parsed, never re-framed. Every
 * long-lived shape a node produces (an exec that answers after an hour,
 * an envd process stream, a proxied SSE) rides through untouched.
 *
 * The dispatcher switches undici's hidden clocks off, for the same reason
 * the SDK's does (packages/sdk/src/client.ts): a node legitimately takes
 * hours to answer an exec, and a default dispatcher gives up on headers
 * after 300s. Connecting keeps a short deadline — a node that will not
 * even accept the connection in ten seconds is unreachable now.
 *
 * Never retried, never re-routed. A create that did not answer may have
 * created; sending it again elsewhere is how one name ends up on two
 * nodes. The caller gets the honest 502, and its retry finds the sandbox
 * by asking (find.ts) wherever it landed.
 */
const CONNECT_TIMEOUT_MS = 10_000;
const agent = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connect: { timeout: CONNECT_TIMEOUT_MS },
});

export interface ForwardTarget {
  endpoint: string;
  /** The fleet's one token: what the gateway presents to every node. */
  token: string;
}

/**
 * How the node is authenticated to: `bearer` replaces the Authorization
 * header with the fleet token (native verbs), `x-api-key` replaces
 * X-API-KEY with `e2b_<token>` (E2B control plane), `none` touches no
 * credential header at all — envd traffic carries its own (an access
 * token minted by the node itself) and the gateway has nothing to add.
 * No header names the real caller: the gateway is the fleet's one door
 * and the node trusts it whole (design record #3).
 */
export type Credential = 'bearer' | 'x-api-key' | 'none';

export interface ForwardOptions {
  target: ForwardTarget;
  credential: Credential;
  /** The request body when Fastify already consumed the stream; omit to stream req itself. */
  body?: Buffer | undefined;
  /**
   * Keep the caller's Host header. Only a face keyed on the Host wants
   * this (the sandbox port proxy, once it routes through the gateway).
   * Everywhere else the Host names the gateway, and carrying it to a node
   * whose Caddy binds that very domain gets a 308 to https instead of the
   * daemon — so the default lets undici name the node's own endpoint.
   */
  preserveHost?: boolean;
}

/** The node did not answer at all — no headers came back. */
export class UnreachableError extends Error {
  constructor(
    readonly node: string,
    /** The transport's word for why (ECONNREFUSED, a timeout, a cut body). */
    readonly why: string,
  ) {
    super(`node ${node} did not answer: ${why}`);
    this.name = 'UnreachableError';
  }
}

// Hop-by-hop headers describe one connection, not the message; a proxy
// that forwards them lies to the next hop about its framing. `expect` is
// one too: the 100-continue handshake is between the client and the
// first server, and Node's http answered it before this code ran (a
// server with no checkContinue listener sends 100 and reads the body).
// undici refuses to forward it outright (NotSupportedError), and curl
// adds it to every body over 1024 bytes — so without this line a 1.5MB
// writeFile through the front was a 502 (measured 2026-09-12).
const HOP_BY_HOP = new Set([
  'connection',
  'expect',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function outboundHeaders(
  req: http.IncomingMessage,
  options: ForwardOptions,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    // A buffered body is re-framed by undici; the client's length may
    // describe a chunked encoding that no longer exists.
    if (name === 'content-length' && options.body !== undefined) continue;
    if (name === 'host' && options.preserveHost !== true) continue;
    headers[name] = value;
  }
  switch (options.credential) {
    case 'bearer':
      headers.authorization = `Bearer ${options.target.token}`;
      break;
    case 'x-api-key':
      headers['x-api-key'] = `e2b_${options.target.token}`;
      break;
    case 'none':
      break;
  }
  return headers;
}

function inboundHeaders(
  headers: Record<string, string | string[] | undefined>,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * The request target is sent to the node exactly as the caller wrote it —
 * origin and path handed to undici separately, never joined into a URL.
 * A URL parser resolves dot segments: `/e2b/api/sandboxes/<id>/../../
 * sandboxes` is a sub-route of a known id to Fastify, which routed it to
 * the id's node, and `/e2b/api/sandboxes` to the parser — so a caller
 * holding any live id could reach the node's create, under the fleet's
 * credential, past placement and the name slot (reproduced 2026-09-12).
 * The node judges the path it is sent; the gateway's routing and the
 * node's must see the same bytes.
 */
async function dispatch(
  req: http.IncomingMessage,
  options: ForwardOptions,
  override: Record<string, string> = {},
  signal?: AbortSignal,
) {
  try {
    return await agent.request({
      origin: options.target.endpoint,
      path: req.url ?? '/',
      method: req.method as 'GET',
      headers: { ...outboundHeaders(req, options), ...override },
      body: options.body ?? req,
      signal,
    });
  } catch (error) {
    throw new UnreachableError(options.target.endpoint, causeOf(error));
  }
}

/**
 * Forwards the request and streams the node's answer back as it arrives;
 * resolves with the node's status once the answer has been relayed (the
 * named verbs read a 404 off it to re-check the cache — find.ts verify).
 * Throws UnreachableError only before any byte of the answer was written;
 * once the head is out, a failure mid-stream can only be a cut connection
 * — there is no honest status left to send. Resolves null when the client
 * left before the node answered: the node-side request is aborted — or,
 * for a client already gone, never sent — and nothing is rendered (the
 * response is gone). Otherwise an abandoned exec
 * against a slow node would hold a gateway→node socket until the node
 * answered — on a hung node, until its TCP died. forwardCapture follows
 * the same rule.
 */
export async function forwardStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ForwardOptions,
): Promise<number | null> {
  // The client left while its sandbox was being found (a lookup round is
  // up to two seconds): 'close' has fired already, the abort below would
  // never come, and the node would run an exec to its end for nobody —
  // forwardCapture's first line, missing here (found by review, 2026-09-14).
  if (res.destroyed) return null;
  const gone = new AbortController();
  const onClose = () => gone.abort();
  res.once('close', onClose);
  let upstream: Awaited<ReturnType<typeof dispatch>>;
  try {
    upstream = await dispatch(req, options, {}, gone.signal);
  } catch (error) {
    if (gone.signal.aborted) return null;
    throw error;
  } finally {
    res.off('close', onClose);
  }
  res.writeHead(upstream.statusCode, inboundHeaders(upstream.headers));
  // Node holds a written head until the first body byte; the node's head
  // has arrived, so it goes out now — a stream that opens and then waits
  // (a process stream before its first event) must look open to the
  // caller, not like a node that has not answered (found by review,
  // 2026-09-14).
  res.flushHeaders();
  try {
    // pipeline destroys both ends on failure: a client that went away
    // aborts the node's response, a node that died cuts the client.
    await pipeline(upstream.body, res);
  } catch {
    res.destroy();
  }
  return upstream.statusCode;
}

export interface CapturedResponse {
  status: number;
  headers: http.OutgoingHttpHeaders;
  body: Buffer;
}

/**
 * Forwards and collects the whole answer, for the few verbs whose answer
 * the gateway must read before passing it on: a create (to learn the id
 * the node minted, for the cache) and a destroy (to forget the entry).
 * Their answers are small JSON; everything else streams.
 *
 * The same abort rule as forwardStream, and for the same reason: a client
 * that leaves before the node has answered takes its request with it, and
 * `null` says so (the caller writes nothing — the response is gone). These
 * verbs hold the name's queue slot, and a request nobody is waiting for
 * must not hold it: a node that accepts the connection and never answers
 * (a daemon with a hung event loop — 2026-08-13 and 2026-09-11 shapes)
 * would otherwise pin the name until its TCP died, every retry queueing
 * behind the abandoned attempt and firing at the node together when it
 * came back. A queued verb whose client left while it waited for the slot
 * is not sent at all. Once the node's head has arrived the small body is
 * read to the end regardless, so a 2xx that did land is still learned.
 */
export async function forwardCapture(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ForwardOptions,
): Promise<CapturedResponse | null> {
  if (res.destroyed) return null;
  const gone = new AbortController();
  const onClose = () => gone.abort();
  res.once('close', onClose);
  let upstream: Awaited<ReturnType<typeof dispatch>>;
  try {
    // The gateway is the reader of this answer, so it states its own
    // preference: identity. A caller's accept-encoding would let a hop
    // that compresses (a Caddy with `encode` in front of the node) hand
    // back bytes the gateway cannot read the id out of.
    upstream = await dispatch(
      req,
      options,
      { 'accept-encoding': 'identity' },
      gone.signal,
    );
  } catch (error) {
    if (gone.signal.aborted) return null;
    throw error;
  } finally {
    res.off('close', onClose);
  }
  let body: Buffer;
  try {
    body = Buffer.from(await upstream.body.arrayBuffer());
  } catch (error) {
    throw new UnreachableError(
      options.target.endpoint,
      `answer cut mid-body: ${causeOf(error)}`,
    );
  }
  return {
    status: upstream.statusCode,
    headers: inboundHeaders(upstream.headers),
    body,
  };
}

/** Writes a captured answer through, verbatim. */
export function replay(
  res: http.ServerResponse,
  answer: CapturedResponse,
): void {
  // The client left while the small body was being read: nothing to say
  // to nobody (what the answer taught the cache is kept regardless).
  if (res.destroyed) return;
  // A 204, a 304 or a 1xx carries no body and must not claim a length
  // (RFC 9110 §8.6): the node sent none, and a `content-length: 0` added
  // here would change the framing this file promises to keep.
  const bodiless =
    answer.status === 204 || answer.status === 304 || answer.status < 200;
  res.writeHead(
    answer.status,
    bodiless
      ? answer.headers
      : { ...answer.headers, 'content-length': String(answer.body.length) },
  );
  res.end(bodiless ? undefined : answer.body);
}

/**
 * The upgrade path (sandbox WebSockets, once the port proxy routes
 * through the gateway): the daemon's own replay (sandbox-proxy.ts
 * handleUpgrade) — dial the node, write the request line and rawHeaders
 * verbatim, then pipe both ways. Plain TCP: node endpoints are
 * private-network http, and a TLS node endpoint is refused here rather
 * than half-supported.
 */
export function forwardUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: ForwardTarget,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
): void {
  socket.on('error', () => socket.destroy());
  const url = new URL(target.endpoint);
  if (url.protocol !== 'http:') {
    // An operator's configuration, refused without naming the address:
    // this face is unauthenticated (raw.ts).
    socket.end(
      `HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify({ message: "the sandbox's node is not a plain http endpoint — upgrades are not forwarded over TLS" })}`,
    );
    return;
  }
  // A URL keeps the brackets of an IPv6 literal in hostname; a dialer
  // wants them off.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  let replayed = false;
  // The HTTP faces' connect deadline (the dispatcher above), here by hand:
  // a node whose host is down without an RST black-holes the SYN, and a
  // bare net.connect would hold the client for the OS's own retry budget
  // (75s on macOS, about two minutes on Linux — measured 2026-09-12 with
  // nc against 192.0.2.1) before the 502 the HTTP faces give in ten.
  // Idle after the handshake is legitimate (a quiet WebSocket), so the
  // timer is switched off the moment the connection is up.
  const upstream = net.connect(
    { port: Number(url.port || 80), host, timeout: connectTimeoutMs },
    () => {
      upstream.setTimeout(0);
      replayed = true;
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      upstream.write(`${raw}\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    },
  );
  upstream.on('timeout', () => upstream.destroy(new Error('connect timeout')));
  upstream.on('error', () => {
    // An HTTP status is honest only before the handshake was replayed;
    // after it the client is inside an upgraded stream (WebSocket frames),
    // where a 502 line would be a corrupt frame, not an answer.
    if (!replayed && !socket.writableEnded && socket.writable) {
      socket.end(
        `HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify({ message: "the sandbox's node did not answer the upgrade — retry" })}`,
      );
    } else {
      socket.destroy();
    }
  });
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
}
