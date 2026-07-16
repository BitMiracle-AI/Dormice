import { z } from 'zod';

/**
 * API keys: ledger-minted credentials that open the same doors as
 * DORMICE_API_TOKEN — the native Bearer face and the E2B X-API-KEY face
 * alike. They exist so the operator can rotate credentials without touching
 * /etc/dormice/env or restarting the daemon: mint a new key, move clients
 * over, revoke the old one. The env token stays valid forever as the
 * bootstrap/recovery credential (and the console-setup root of trust — a
 * key can NOT reset the console password).
 *
 * Every key is full-power over sandboxes, with exactly one carve-out: the
 * apiKey management verbs themselves (create/list/update/revoke) accept
 * only the env token or a console session. A key that could manage keys is
 * a self-replication ladder — one leaked credential minting itself an
 * unrevoked successor and revoking every legitimate peer. Rotating
 * credentials is an administrator's act, so it takes an administrator's
 * credential. There is no other per-key authorization scoping — that would
 * be a multi-tenant model, and Dormice is single-operator.
 *
 * The key material is 64 hex chars, no brand prefix: the official Python
 * E2B SDK validates `e2b_[0-9a-f]+` client-side, so anything non-hex could
 * never be used on the E2B face at all.
 */
export const apiKeyNameSchema = z.string().trim().min(1).max(64);

export const apiKeySchema = z.object({
  /**
   * Row identity (UUID) and the wire address for update/revoke — the name
   * became renameable, so the id is the stable handle (the sandbox
   * name/id doctrine, applied to keys).
   */
  id: z.string(),
  name: apiKeyNameSchema,
  /**
   * First 8 hex chars of the key — enough to match a leaked credential to
   * its row without giving away meaningful entropy (32 of 256 bits).
   */
  prefix: z.string(),
  createdAt: z.iso.datetime(),
  /** Null = never used. Written with 60s granularity, not per request. */
  lastUsedAt: z.iso.datetime().nullable(),
  /**
   * Null = never expires. Always daemon-normalized toISOString() shape, so
   * the daemon's string comparison against "now" is chronologically sound.
   * An expired key stops verifying but keeps its name — extend it through
   * updateApiKey or revoke it; only revoke frees the name.
   */
  expiresAt: z.iso.datetime().nullable(),
  /**
   * Null = enabled. Disabling is the reversible half of revoking: the key
   * stops verifying on the next request but keeps its name and can be
   * re-enabled — a hold, where revoke is an amputation.
   */
  disabledAt: z.iso.datetime().nullable(),
  /** Null = active. Revoked rows stay listed — they are the rotation history. */
  revokedAt: z.iso.datetime().nullable(),
});

export type ApiKey = z.infer<typeof apiKeySchema>;

/**
 * The one display translation of a row into a lifecycle word, shared by the
 * CLI table and the console badge so the two never drift. Precedence:
 * revoked is terminal history, disabled is a deliberate operator act, and
 * expired merely happened — so each earlier state wins over the later ones.
 * The daemon's SQL liveness filter is the authentication arbiter; this is
 * the presentation arbiter. One of each.
 */
export type ApiKeyStatus = 'active' | 'disabled' | 'expired' | 'revoked';

export function apiKeyStatus(
  key: Pick<ApiKey, 'revokedAt' | 'disabledAt' | 'expiresAt'>,
  nowMs: number,
): ApiKeyStatus {
  if (key.revokedAt !== null) return 'revoked';
  if (key.disabledAt !== null) return 'disabled';
  if (key.expiresAt !== null && Date.parse(key.expiresAt) <= nowMs) {
    return 'expired';
  }
  return 'active';
}

/**
 * createApiKey(name, expiresAt?) — mints a key and returns the token
 * exactly once. The ledger stores only its sha256, so no later call can
 * ever reveal it again. A second active key under the same name is refused
 * with a 409: two live credentials answering to one name is a rotation
 * mistake, not a goal.
 */
export const createApiKeyRequestSchema = z.object({
  name: apiKeyNameSchema,
  /** Omitted = never expires. */
  expiresAt: z.iso.datetime().optional(),
});

export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;

export const createApiKeyResponseSchema = z.object({
  apiKey: apiKeySchema,
  /** The 64-hex key material. Shown here once; never retrievable again. */
  token: z.string(),
});

export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>;

/** listApiKeys() — every key ever minted, revoked ones included, newest first. */
export const listApiKeysResponseSchema = z.object({
  apiKeys: z.array(apiKeySchema),
});

export type ListApiKeysResponse = z.infer<typeof listApiKeysResponseSchema>;

/**
 * updateApiKey(id, patch) — edits a live key in place. An absent field is
 * untouched (the updatePolicy patch idiom); expiresAt: null clears to
 * never-expires; disabled: true/false parks or resumes the key (true on an
 * already-disabled key is idempotent and keeps the original disabledAt).
 * An unknown id is a 404; a revoked row is a 409 — revoked rows are
 * rotation history, not editable credentials; renaming onto a name held by
 * a live key is a 409 (create's courtesy).
 */
export const updateApiKeyRequestSchema = z.object({
  id: z.string(),
  name: apiKeyNameSchema.optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  disabled: z.boolean().optional(),
});

export type UpdateApiKeyRequest = z.infer<typeof updateApiKeyRequestSchema>;

export const updateApiKeyResponseSchema = z.object({
  apiKey: apiKeySchema,
});

export type UpdateApiKeyResponse = z.infer<typeof updateApiKeyResponseSchema>;

/**
 * revokeApiKey(id) — soft-revokes the key: the row stays as history, the
 * credential stops opening doors on the next request, the name is freed
 * for reuse. Idempotent like destroySandbox: "this key is not live" is the
 * desired end state, so an unknown or already-revoked id answers
 * { revoked: false } rather than an error. Callers should say that false
 * out loud — a miss here would leave a leaked key alive.
 */
export const revokeApiKeyRequestSchema = z.object({
  id: z.string(),
});

export type RevokeApiKeyRequest = z.infer<typeof revokeApiKeyRequestSchema>;

export const revokeApiKeyResponseSchema = z.object({
  /** True when a live-or-disabled key existed and was revoked; false when none did. */
  revoked: z.boolean(),
});

export type RevokeApiKeyResponse = z.infer<typeof revokeApiKeyResponseSchema>;
