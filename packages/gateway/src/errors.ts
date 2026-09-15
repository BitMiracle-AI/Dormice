import type http from 'node:http';
import { UnreachableError } from './forward';

/** What relay needs of a logger — pino's and Fastify's request logger both fit. */
export interface ErrorLog {
  error(obj: unknown, msg?: string): void;
}

/**
 * Every face the gateway fronts has its own error dialect, and an error
 * the gateway itself produces must wear the dialect of the face it was
 * asked on — a client library parses what it expects:
 *   native  { message }                        the daemon's API
 *   control { code: <http status>, message }   E2B's control plane (openapi-fetch checks error.code === 404)
 *   connect { code: '<connect code>', message } E2B's envd (Connect RPC's string codes)
 * Errors a node produced are forwarded verbatim and never re-dressed.
 */
export type Dialect = 'native' | 'control' | 'connect';

export interface RenderedError {
  status: number;
  message: string;
  /** Connect's string code, used by the connect dialect only. */
  connectCode?: string;
  /** Browser-consumable faces carry CORS on errors too, or the refusal is unreadable. */
  cors?: boolean;
  /** Seconds — on a 503 whose cause the caller may simply outwait. */
  retryAfterSeconds?: number;
}

export function errorBody(dialect: Dialect, error: RenderedError): string {
  switch (dialect) {
    case 'native':
      return JSON.stringify({ message: error.message });
    case 'control':
      return JSON.stringify({ code: error.status, message: error.message });
    case 'connect':
      return JSON.stringify({
        code: error.connectCode ?? 'unknown',
        message: error.message,
      });
  }
}

/** Writes an error the gateway produced, on a raw response, in the face's dialect. */
export function renderError(
  res: http.ServerResponse,
  dialect: Dialect,
  error: RenderedError,
): void {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  const body = errorBody(dialect, error);
  const headers: http.OutgoingHttpHeaders = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  };
  if (error.cors) headers['access-control-allow-origin'] = '*';
  if (error.retryAfterSeconds !== undefined) {
    headers['retry-after'] = String(error.retryAfterSeconds);
  }
  res.writeHead(error.status, headers);
  res.end(body);
}

/** The preflight answer of the browser-consumable faces — the daemon's cors.ts shape. */
export function sendPreflight(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const requested = req.headers['access-control-request-headers'];
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers':
      typeof requested === 'string' && requested !== '' ? requested : '*',
    'access-control-max-age': '7200',
  });
  res.end();
}

/**
 * Runs one forwarding step on a response the gateway owns (a hijacked
 * reply, a raw face) and turns its failure into an answer in the face's
 * dialect: the node's transport failure is a 502 rendered by `unreachable`
 * (what the caller may do next), anything else a 500 that sends the
 * operator to the log. Never silence: Fastify writes nothing for a
 * hijacked reply whose handler throws, the gateway has no request timeout
 * of its own, and a raw face has no framework behind it at all — so a
 * step that threw after the node had answered would leave the caller
 * waiting forever with the sandbox already built (found by review,
 * 2026-09-12).
 */
export async function relay(
  res: http.ServerResponse,
  dialect: Dialect,
  log: ErrorLog,
  step: () => Promise<void>,
  unreachable: (error: UnreachableError) => RenderedError,
  /** CORS on the 500 too; the browser-consumable faces (connect, and the proxy's browser-direct file form) need it to read any answer. */
  cors: boolean = dialect === 'connect',
): Promise<void> {
  try {
    await step();
  } catch (error) {
    if (error instanceof UnreachableError) {
      renderError(res, dialect, unreachable(error));
      return;
    }
    log.error(error, 'forwarding failed on the gateway');
    renderError(res, dialect, {
      status: 500,
      message: 'the gateway failed while forwarding — see its log',
      cors,
    });
  }
}
