import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * CORS for the browser-consumable file faces — the signed-URL door (which
 * the 49983 subdomain form also lands on) and the envd /files face. The
 * wildcard origin is deliberate and real E2B's own posture: the URL's
 * signature IS the capability, no cookies ride these requests, so an
 * origin allowlist would add nothing while breaking the legitimate
 * consumer — a browser on some app's origin uploading straight into the
 * sandbox without the app's server relaying bytes.
 *
 * Errors must carry the header too: a 401 without ACAO is unreadable to
 * the browser, which can only report an opaque "CORS failure" instead of
 * the real refusal.
 */
export function allowCorsOrigin(reply: FastifyReply): void {
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-expose-headers', EXPOSED_FILE_HEADERS);
}

/**
 * Response headers browser JS may read beyond the CORS safelist:
 * content-range/accept-ranges carry the Range contract (a JS video player
 * or resuming downloader is blind without them), content-disposition
 * carries the filename. The hijacked download head re-states this list.
 */
export const EXPOSED_FILE_HEADERS =
  'accept-ranges, content-range, content-disposition';

/**
 * The preflight answer, real E2B's shape (204 + methods + a 2h cache).
 * Unconditional by necessity: browsers send preflights credential-less,
 * so there is nothing to authenticate — the POST itself is judged.
 * Requested headers are echoed back; an XHR with upload.onprogress always
 * preflights, so this route is the gate the whole browser flow hangs on.
 */
export function sendPreflight(request: FastifyRequest, reply: FastifyReply) {
  const requested = request.headers['access-control-request-headers'];
  return reply
    .code(204)
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-methods', 'GET, POST, OPTIONS')
    .header(
      'access-control-allow-headers',
      typeof requested === 'string' && requested !== '' ? requested : '*',
    )
    .header('access-control-max-age', '7200')
    .send();
}
