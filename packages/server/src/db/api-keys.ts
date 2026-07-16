import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { recordActivity } from './activity';
import type { Db } from './db';
import { type ApiKeyRow, apiKeys } from './schema';

/**
 * lastUsedAt write granularity. A hot-polling client authenticates many
 * times a second; writing the ledger on every hit would turn the WAL into
 * an EKG for zero information. One write a minute answers the only question
 * the column exists for — "is this key still alive, roughly since when".
 */
const LAST_USED_GRANULARITY_MS = 60_000;

/** sha256 hex of the bare key material — the only form the ledger stores. */
export function hashApiKeyToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mints a key and returns the material exactly once — the row keeps only
 * the hash, so this return value is the caller's single chance to see it.
 * Pure hex, no brand prefix: the official Python E2B SDK validates
 * `e2b_[0-9a-f]+` client-side, so anything non-hex could never be used on
 * the X-API-KEY face at all.
 *
 * The caller (route) has already refused a duplicate active name with a
 * 409; the partial unique index backstops that check as a schema fact.
 */
export function createApiKey(
  db: Db,
  name: string,
): { row: ApiKeyRow; token: string } {
  const token = randomBytes(32).toString('hex');
  const row: ApiKeyRow = {
    id: randomUUID(),
    name,
    keyHash: hashApiKeyToken(token),
    prefix: token.slice(0, 8),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  };
  db.insert(apiKeys).values(row).run();
  recordActivity(db, {
    kind: 'apikey-created',
    detail: `API key "${name}" (prefix ${row.prefix}) minted`,
  });
  return { row, token };
}

export function findActiveApiKeyByName(
  db: Db,
  name: string,
): ApiKeyRow | undefined {
  return db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.name, name), isNull(apiKeys.revokedAt)))
    .get();
}

/**
 * Every key ever minted, revoked ones included — the rotation history.
 * createdAt has millisecond granularity, so two keys minted back-to-back
 * can tie; rowid breaks the tie by insertion order, and it is trustworthy
 * here because api_keys rows are never deleted (revoke is soft), so rowids
 * are never reused.
 */
export function listApiKeys(db: Db): ApiKeyRow[] {
  return db
    .select()
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt), desc(sql`rowid`))
    .all();
}

/**
 * Soft-revokes the active key under this name. Returns false when none was
 * active — the desired end state was already true. The row survives as
 * history; the name is immediately free for a new key.
 */
export function revokeApiKey(db: Db, name: string): boolean {
  const result = db
    .update(apiKeys)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(apiKeys.name, name), isNull(apiKeys.revokedAt)))
    .run();
  const revoked = result.changes > 0;
  if (revoked) {
    recordActivity(db, {
      kind: 'apikey-revoked',
      detail: `API key "${name}" revoked`,
    });
  }
  return revoked;
}

/**
 * The ledger leg of credential verification: does this bare token match an
 * active key? An indexed exact-match lookup on sha256(token) — not a
 * timing-safe scan, deliberately: the comparison can at worst leak bytes of
 * sha256(key), which preimage resistance makes worthless to an attacker
 * (the argument GitHub token storage rests on).
 *
 * A hit also stamps lastUsedAt, throttled to LAST_USED_GRANULARITY_MS so a
 * polling client does not write the ledger per request. ISO strings compare
 * lexicographically as timestamps, so the cutoff is a plain string <.
 */
export function verifyApiKeyToken(db: Db, bareToken: string): boolean {
  const hash = hashApiKeyToken(bareToken);
  const row = db
    .select({ id: apiKeys.id, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .get();
  if (!row) {
    return false;
  }
  const now = Date.now();
  const cutoff = new Date(now - LAST_USED_GRANULARITY_MS).toISOString();
  db.update(apiKeys)
    .set({ lastUsedAt: new Date(now).toISOString() })
    .where(
      and(
        eq(apiKeys.id, row.id),
        or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, cutoff)),
      ),
    )
    .run();
  return true;
}
