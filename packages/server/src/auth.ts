import {
  createHash,
  createHmac,
  randomBytes,
  type ScryptOptions,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import type { onRequestAsyncHookHandler } from 'fastify';

// Hand-rolled instead of util.promisify: promisify picks the overload
// without the options argument, and the cost parameters live there.
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time string comparison; both sides hashed so lengths never leak. */
export function tokensEqual(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

/**
 * Password hashing for the console account: scrypt (in node:crypto, zero
 * dependencies — the whole reason it wins over bcrypt/argon2 here). The
 * parameters ride inside the stored string, so they can change later
 * without invalidating old hashes.
 *
 * N=2^14, r=8, p=1 (~16 MiB, tens of ms): the standard interactive-login
 * cost. The online-guessing defense is the login throttle; this cost is
 * for the offline case, a stolen ledger file.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) {
    return false;
  }
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(
    password,
    Buffer.from(saltB64, 'base64'),
    expected.length,
    { N: Number(n), r: Number(r), p: Number(p) },
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The session-cookie HMAC key: random, stored on the account row. */
export function mintSessionSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The web console's session cookie. Stateless on purpose: the daemon is
 * crash-only, and an in-memory session table would log every operator out
 * on each restart. The value carries its own expiry and an HMAC over it —
 * the same pattern as the envd access token — so a restart changes nothing.
 *
 * The HMAC key is the account's sessionSecret, not the API token: the two
 * credentials rotate independently. Re-running setup (password change or
 * reset) regenerates the secret and voids every session — the semantics a
 * password change should have — while rotating the API token leaves the
 * console signed in.
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

function sessionHmac(secret: string, expiresAtSeconds: number): string {
  return createHmac('sha256', secret)
    .update(`console-session:${expiresAtSeconds}`)
    .digest('hex');
}

export function mintSession(secret: string, nowMs = Date.now()): string {
  const expiresAt = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  return `${expiresAt}.${sessionHmac(secret, expiresAt)}`;
}

export function verifySession(
  secret: string,
  value: string,
  nowMs = Date.now(),
): boolean {
  const dot = value.indexOf('.');
  if (dot < 0) return false;
  const expiresAt = Number(value.slice(0, dot));
  // The expiry is plaintext in the cookie — nothing secret to compare in
  // constant time. The HMAC comparison below is the constant-time one.
  if (!Number.isInteger(expiresAt) || expiresAt * 1000 <= nowMs) return false;
  return tokensEqual(value.slice(dot + 1), sessionHmac(secret, expiresAt));
}

/**
 * The single arbiter of who may call the API (/healthz stays open —
 * liveness probes have no secrets). Two credentials open the same door:
 * the Bearer token (SDK, CLI, curl) and the web console's session cookie
 * (which additionally requires the console header, see above). A second
 * route surface with its own auth would be a second truth.
 *
 * The session secret is fetched per request, not captured at startup: setup
 * can replace the account (and its secret) while the daemon runs, and the
 * arbiter must judge against the current one. Null means no account exists
 * yet — no cookie can be valid.
 */
export function requireApiAuth(
  token: string,
  getSessionSecret: () => string | null,
): onRequestAsyncHookHandler {
  return async (request, reply) => {
    if (tokensEqual(request.headers.authorization ?? '', `Bearer ${token}`)) {
      return;
    }
    const cookie = request.cookies?.[SESSION_COOKIE];
    const secret = getSessionSecret();
    if (
      cookie &&
      secret !== null &&
      request.headers[CONSOLE_HEADER] !== undefined &&
      verifySession(secret, cookie)
    ) {
      return;
    }
    await reply.code(401).send({ message: 'missing or invalid API token' });
  };
}
