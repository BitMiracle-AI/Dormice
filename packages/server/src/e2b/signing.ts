import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/db';
import { listSandboxes } from '../db/ledger';
import type { SandboxRow } from '../db/schema';
import { E2bError, mintEnvdToken } from './protocol';
import { e2bView } from './view';

/**
 * The E2B file-URL signature, pinned against both ends of the official
 * implementation (the SDK's getSignature and real envd's auth.go):
 *
 *   "v1_" + base64( sha256( path:operation:username:token[:expiration] ) )
 *
 * — standard base64 alphabet, '=' padding stripped. `path` and `username`
 * are empty strings when absent (the SDK omits both by default against an
 * envd >= 0.4.0, which we report); `expiration` is an absolute unix-seconds
 * timestamp, present in the material exactly when the URL carries
 * `signature_expiration`. The token is the sandbox's envd access token.
 */
export type SigningOperation = 'read' | 'write';

export interface SignatureMaterial {
  path: string;
  operation: SigningOperation;
  username: string;
  expirationUnix?: number;
}

export function fileSignature(
  envdAccessToken: string,
  m: SignatureMaterial,
): string {
  const parts = [m.path, m.operation, m.username, envdAccessToken];
  if (m.expirationUnix !== undefined) parts.push(String(m.expirationUnix));
  const digest = createHash('sha256')
    .update(parts.join(':'), 'utf8')
    .digest('base64');
  return `v1_${digest.replace(/=+$/, '')}`;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time: does `presented` match what this token would sign? */
function matchesToken(
  token: string,
  material: SignatureMaterial,
  presented: string,
): boolean {
  const expected = fileSignature(token, material);
  return timingSafeEqual(sha256(expected), sha256(presented));
}

/**
 * Which sandbox does this signature speak for? A signed URL arrives bare —
 * no headers, no sandbox id anywhere (the SDK's fileUrl builds
 * `<origin>/files?...` and browsers add nothing) — but every sandbox's
 * access token is different, so the signature itself binds the sandbox:
 * compute the expected signature per live ledger row and take the match.
 * At most DORMICE_MAX_SANDBOXES hashes per request — microseconds.
 *
 * This is the single-domain answer to what real E2B solves with one
 * subdomain per sandbox; the deliberate divergence is documented in the
 * protocol rules.
 */
function findRowBySignature(
  db: Db,
  signingSecret: string,
  material: SignatureMaterial,
  presented: string,
): SandboxRow | undefined {
  const now = new Date();
  for (const row of listSandboxes(db)) {
    if (e2bView(row, now) === 'dead') continue;
    if (matchesToken(mintEnvdToken(signingSecret, row.id), material, presented))
      return row;
  }
  return undefined;
}

/** The query half of a signed file URL, as the SDK's uploadUrl/downloadUrl mint it. */
export interface SignedFileQuery {
  path?: string;
  username?: string;
  signature?: string;
  signature_expiration?: string;
}

/**
 * The one adjudication of a signed file query, in real envd's
 * validateSigning order: missing signature first, then the constant-time
 * match, and only then the expiration — a wrong signature must never learn
 * from the error whether it was also expired. Returns the sandbox id the
 * signature speaks for; throws the envd-dialect 401s.
 *
 * Two identity sources, mirroring the two URL forms:
 *  - pinned — the sandbox id arrived out of band (the `49983-<id>.<domain>`
 *    Host label, or the envd surface's E2b-Sandbox-Id header). The
 *    signature must match exactly that sandbox, real E2B's semantics: a
 *    signature minted for sandbox A opens no other sandbox's door, whatever
 *    else it would match. Existence/liveness is judged downstream by the
 *    wake gate (502, like every envd verb against a dead sandbox).
 *  - unpinned — the bare single-domain form: the signature itself is the
 *    identity, recovered by scanning the live ledger rows.
 */
export function authenticateSignedQuery(opts: {
  db: Db;
  signingSecret: string;
  query: SignedFileQuery;
  operation: SigningOperation;
  pinnedSandboxId?: string;
}): string {
  const { db, signingSecret, query, operation, pinnedSandboxId } = opts;
  if (!query.signature) {
    throw new E2bError(
      401,
      'unauthenticated',
      'missing signature query parameter',
    );
  }
  const expirationUnix =
    query.signature_expiration === undefined
      ? undefined
      : Number(query.signature_expiration);
  const material: SignatureMaterial = {
    path: query.path ?? '',
    operation,
    username: query.username ?? '',
    ...(expirationUnix === undefined ? {} : { expirationUnix }),
  };
  const sandboxId =
    pinnedSandboxId !== undefined
      ? matchesToken(
          mintEnvdToken(signingSecret, pinnedSandboxId),
          material,
          query.signature,
        )
        ? pinnedSandboxId
        : undefined
      : findRowBySignature(db, signingSecret, material, query.signature)?.id;
  if (sandboxId === undefined) {
    throw new E2bError(401, 'unauthenticated', 'invalid signature');
  }
  if (
    expirationUnix !== undefined &&
    expirationUnix < Math.floor(Date.now() / 1000)
  ) {
    throw new E2bError(401, 'unauthenticated', 'signature is already expired');
  }
  return sandboxId;
}
