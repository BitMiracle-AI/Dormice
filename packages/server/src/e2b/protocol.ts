import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The envd version this compat layer claims. Deliberately 0.6.1: at or
 * above 0.5.7 the SDK is willing to upload via octet-stream (we support
 * it), below 0.6.2 it refuses file-metadata options client-side (we do not
 * support xattr metadata) — the SDK blocks what we cannot do instead of us
 * accepting data and silently dropping it. Raise only together with the
 * features a higher number promises.
 */
export const ENVD_VERSION = '0.6.1';

/**
 * Errors on the E2B surface carry the E2B wire shape `{ code, message }` —
 * a different dialect from the native `{ message }`, adjudicated per scope
 * by each compat plugin's own error handler. Two sub-dialects, both
 * verified against the official SDK: the control plane's `code` is the
 * NUMERIC status (openapi-fetch literally checks `error.code === 404`),
 * Connect RPC's `code` is the protocol's string ('not_found', ...).
 */
export class E2bError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string | number,
    message: string,
  ) {
    super(message);
  }
}

/** A control-plane error: numeric code mirroring the status, per E2B's openapi. */
export function apiError(status: number, message: string): E2bError {
  return new E2bError(status, status, message);
}

/**
 * Connect RPC error codes -> HTTP status, per the Connect protocol's unary
 * mapping. Only the codes this layer actually emits.
 */
const CONNECT_STATUS: Record<string, number> = {
  invalid_argument: 400,
  unauthenticated: 401,
  not_found: 404,
  already_exists: 409,
  resource_exhausted: 429,
  internal: 500,
  unimplemented: 501,
  unavailable: 502,
};

export function connectError(code: string, message: string): E2bError {
  return new E2bError(CONNECT_STATUS[code] ?? 500, code, message);
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/**
 * The per-sandbox envd access token: HMAC(signing secret, sandbox id).
 * Stateless — the daemon verifies without a lookup, and the SDK treats the
 * value as opaque (it just echoes what create returned). Keyed by the
 * ledger's signing secret, not the API token, so the two credentials
 * rotate independently — no client can (or should) recompute this.
 */
export function mintEnvdToken(
  signingSecret: string,
  sandboxId: string,
): string {
  return createHmac('sha256', signingSecret)
    .update(`envd:${sandboxId}`)
    .digest('hex');
}

export function verifyEnvdToken(
  signingSecret: string,
  sandboxId: string,
  presented: string,
): boolean {
  // Hash both sides so timingSafeEqual gets equal lengths, constant-time.
  return timingSafeEqual(
    sha256(presented),
    sha256(mintEnvdToken(signingSecret, sandboxId)),
  );
}

/**
 * X-API-KEY check. The official SDK formats keys as `e2b_<hex>` and our
 * hex credentials are compliant as `e2b_<token>`; the bare token is
 * accepted too — the prefix is the SDK's convention, not a secret. What
 * opens the door — and who it is — is adjudicated by identifyCredential
 * (buildApp's closure: env token or any active ledger API key), the same
 * truth the native Bearer face consults; the answer is the actor (null =
 * refused).
 */
export function identifyApiKey(
  identifyCredential: (bareToken: string) => string | null,
  presented: string | undefined,
): string | null {
  const bare = presented?.startsWith('e2b_') ? presented.slice(4) : presented;
  return bare === undefined ? null : identifyCredential(bare);
}

/** Connect streaming envelope flags: 0x00 = message, 0x02 = end of stream. */
export const FLAG_MESSAGE = 0x00;
export const FLAG_END_STREAM = 0x02;

/**
 * Connect streaming envelope: 1 flag byte + 4-byte big-endian payload
 * length + JSON payload. The JSON codec because the SDK is configured with
 * useBinaryFormat: false — no protobuf wire format anywhere.
 */
export function envelope(flags: number, json: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(json), 'utf8');
  const head = Buffer.alloc(5);
  head.writeUInt8(flags, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/**
 * Extracts the first enveloped message of a streaming request body — a
 * Start request carries exactly one.
 */
export function readFirstMessage(body: Buffer): unknown {
  if (body.length < 5) {
    throw connectError('invalid_argument', 'truncated connect envelope');
  }
  const length = body.readUInt32BE(1);
  if (body.length < 5 + length) {
    throw connectError('invalid_argument', 'truncated connect envelope');
  }
  try {
    return JSON.parse(body.subarray(5, 5 + length).toString('utf8'));
  } catch {
    throw connectError('invalid_argument', 'connect envelope is not JSON');
  }
}
