import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
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
 * The one write-side shape for timestamps that later feed string
 * comparisons. Wire ISO input has variable precision ("…00Z" sorts after
 * "…00.500Z" while being chronologically earlier), so every expiresAt is
 * normalized to exact toISOString() output before it touches the ledger —
 * after that, plain string compare is chronologically sound (the same
 * argument the lastUsedAt throttle rests on).
 */
function normalizeIso(value: string): string {
  return new Date(value).toISOString();
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
  expiresAt: string | undefined,
  actor: string | null,
): { row: ApiKeyRow; token: string } {
  const token = randomBytes(32).toString('hex');
  const row: ApiKeyRow = {
    id: randomUUID(),
    name,
    keyHash: hashApiKeyToken(token),
    prefix: token.slice(0, 8),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    expiresAt: expiresAt ? normalizeIso(expiresAt) : null,
    disabledAt: null,
    revokedAt: null,
  };
  db.insert(apiKeys).values(row).run();
  recordActivity(db, {
    kind: 'apikey-created',
    // The admin gate means this actor can only be env-token or console —
    // a key can never appear as the minter of another key.
    actor,
    detail:
      `API key "${name}" (prefix ${row.prefix}) minted` +
      (row.expiresAt ? `, expires ${row.expiresAt}` : ''),
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

export function findApiKeyById(db: Db, id: string): ApiKeyRow | undefined {
  return db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
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
 * Soft-revokes the key with this id. Returns false when it does not exist
 * or is already revoked — the desired end state was already true. The row
 * survives as history; the name is immediately free for a new key.
 */
export function revokeApiKey(
  db: Db,
  id: string,
  actor: string | null,
): boolean {
  const row = findApiKeyById(db, id);
  if (!row || row.revokedAt !== null) {
    return false;
  }
  db.update(apiKeys)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, id))
    .run();
  recordActivity(db, {
    kind: 'apikey-revoked',
    actor,
    detail: `API key "${row.name}" revoked`,
  });
  return true;
}

/**
 * Edits a non-revoked key in place. The route has already adjudicated the
 * 404 (unknown id), the 409s (revoked row, name collision) — this function
 * only computes the changed-field set against the row it was handed and
 * writes once. A field equal to its current value is not a change (the
 * updatePolicy idiom: a no-op patch is the goal state, not an error), so
 * disabling an already-disabled key keeps its original disabledAt and
 * records nothing. One request can still yield two activity events — a
 * disable that also renames is two facts, each separately filterable.
 */
export function updateApiKey(
  db: Db,
  row: ApiKeyRow,
  patch: { name?: string; expiresAt?: string | null; disabled?: boolean },
  actor: string | null,
): ApiKeyRow {
  const changes: Partial<ApiKeyRow> = {};
  const facts: {
    kind: 'apikey-updated' | 'apikey-disabled' | 'apikey-enabled';
    detail: string;
  }[] = [];
  const updated: string[] = [];

  if (patch.name !== undefined && patch.name !== row.name) {
    changes.name = patch.name;
    updated.push(`renamed to "${patch.name}"`);
  }
  if (patch.expiresAt !== undefined) {
    const next =
      patch.expiresAt === null ? null : normalizeIso(patch.expiresAt);
    if (next !== row.expiresAt) {
      changes.expiresAt = next;
      updated.push(`expires ${row.expiresAt ?? 'never'} -> ${next ?? 'never'}`);
    }
  }
  if (updated.length > 0) {
    facts.push({
      kind: 'apikey-updated',
      detail: `API key "${row.name}" ${updated.join(', ')}`,
    });
  }
  if (patch.disabled === true && row.disabledAt === null) {
    changes.disabledAt = new Date().toISOString();
    facts.push({
      kind: 'apikey-disabled',
      detail: `API key "${row.name}" disabled`,
    });
  } else if (patch.disabled === false && row.disabledAt !== null) {
    changes.disabledAt = null;
    facts.push({
      kind: 'apikey-enabled',
      detail: `API key "${row.name}" enabled`,
    });
  }

  if (Object.keys(changes).length === 0) {
    return row;
  }
  db.update(apiKeys).set(changes).where(eq(apiKeys.id, row.id)).run();
  for (const fact of facts) {
    recordActivity(db, { ...fact, actor });
  }
  return { ...row, ...changes };
}

/**
 * The single liveness adjudication: revoked, disabled and expired all close
 * the door, in one WHERE. Pure read — it never stamps lastUsedAt — so the
 * admin gate can consult it for its honest 403 without a refused request
 * leaving "recently used" fingerprints. The expiry compare is a plain
 * string > against toISOString(now), sound because expiresAt is normalized
 * on write (see normalizeIso).
 */
export function findLiveApiKeyByHash(
  db: Db,
  hash: string,
): { id: string; lastUsedAt: string | null } | undefined {
  return db
    .select({ id: apiKeys.id, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keyHash, hash),
        isNull(apiKeys.revokedAt),
        isNull(apiKeys.disabledAt),
        or(
          isNull(apiKeys.expiresAt),
          gt(apiKeys.expiresAt, new Date().toISOString()),
        ),
      ),
    )
    .get();
}

/** findLiveApiKeyByHash for callers holding the bare token — hashing stays in this module. */
export function isLiveApiKey(db: Db, bareToken: string): boolean {
  return findLiveApiKeyByHash(db, hashApiKeyToken(bareToken)) !== undefined;
}

/**
 * The ledger leg of credential verification: does this bare token match a
 * live key? An indexed exact-match lookup on sha256(token) — not a
 * timing-safe scan, deliberately: the comparison can at worst leak bytes of
 * sha256(key), which preimage resistance makes worthless to an attacker
 * (the argument GitHub token storage rests on).
 *
 * A hit answers the key's id (attribution's raw material — the auth hook
 * dresses it as an actor and rides it on the request) and stamps lastUsedAt
 * — only a hit: verification is the one moment a credential was actually
 * honored. Throttled to LAST_USED_GRANULARITY_MS so a polling client does
 * not write the ledger per request. ISO strings compare lexicographically
 * as timestamps, so the cutoff is a plain string <.
 */
export function verifyApiKeyToken(db: Db, bareToken: string): string | null {
  const row = findLiveApiKeyByHash(db, hashApiKeyToken(bareToken));
  if (!row) {
    return null;
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
  return row.id;
}
