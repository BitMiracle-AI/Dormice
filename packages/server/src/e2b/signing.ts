import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/db';
import { listSandboxes } from '../db/ledger';
import type { SandboxRow } from '../db/schema';
import { mintEnvdToken } from './protocol';
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
export function findRowBySignature(
  db: Db,
  signingSecret: string,
  material: SignatureMaterial,
  presented: string,
): SandboxRow | undefined {
  const now = new Date();
  for (const row of listSandboxes(db)) {
    if (e2bView(row, now) === 'dead') continue;
    const expected = fileSignature(
      mintEnvdToken(signingSecret, row.sandboxId),
      material,
    );
    if (timingSafeEqual(sha256(expected), sha256(presented))) return row;
  }
  return undefined;
}
