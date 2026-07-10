import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { onRequestAsyncHookHandler } from 'fastify';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time string comparison; both sides hashed so lengths never leak. */
export function tokensEqual(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

/**
 * The web console's session cookie. Stateless on purpose: the daemon is
 * crash-only, and an in-memory session table would log every operator out
 * on each restart. The value carries its own expiry and an HMAC over it —
 * the same pattern as the envd access token — so a restart changes nothing
 * and rotating the API token invalidates every session at once.
 */
export const SESSION_COOKIE = 'dormice_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Cookie-authenticated requests must also carry this header. A cross-origin
 * page cannot send a custom header without a CORS preflight, and the daemon
 * answers no preflights — this closes the hole SameSite leaves open
 * (SameSite ignores the port, so another local web app counts as same-site).
 */
export const CONSOLE_HEADER = 'x-dormice-console';

function sessionHmac(apiToken: string, expiresAtSeconds: number): string {
  return createHmac('sha256', apiToken)
    .update(`console-session:${expiresAtSeconds}`)
    .digest('hex');
}

export function mintSession(apiToken: string, nowMs = Date.now()): string {
  const expiresAt = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  return `${expiresAt}.${sessionHmac(apiToken, expiresAt)}`;
}

export function verifySession(
  apiToken: string,
  value: string,
  nowMs = Date.now(),
): boolean {
  const dot = value.indexOf('.');
  if (dot < 0) return false;
  const expiresAt = Number(value.slice(0, dot));
  // The expiry is plaintext in the cookie — nothing secret to compare in
  // constant time. The HMAC comparison below is the constant-time one.
  if (!Number.isInteger(expiresAt) || expiresAt * 1000 <= nowMs) return false;
  return tokensEqual(value.slice(dot + 1), sessionHmac(apiToken, expiresAt));
}

/**
 * The single arbiter of who may call the API (/healthz stays open —
 * liveness probes have no secrets). Two credentials open the same door:
 * the Bearer token (SDK, CLI, curl) and the web console's session cookie
 * (which additionally requires the console header, see above). A second
 * route surface with its own auth would be a second truth.
 */
export function requireApiAuth(token: string): onRequestAsyncHookHandler {
  return async (request, reply) => {
    if (tokensEqual(request.headers.authorization ?? '', `Bearer ${token}`)) {
      return;
    }
    const cookie = request.cookies?.[SESSION_COOKIE];
    if (
      cookie &&
      request.headers[CONSOLE_HEADER] !== undefined &&
      verifySession(token, cookie)
    ) {
      return;
    }
    await reply.code(401).send({ message: 'missing or invalid API token' });
  };
}
