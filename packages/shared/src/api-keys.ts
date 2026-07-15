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
 * Every key is full-power. There is no per-key authorization scoping —
 * that would be a multi-tenant model, and Dormice is single-operator.
 *
 * The key material is 64 hex chars, no brand prefix: the official Python
 * E2B SDK validates `e2b_[0-9a-f]+` client-side, so anything non-hex could
 * never be used on the E2B face at all.
 */
export const apiKeyNameSchema = z.string().trim().min(1).max(64);

export const apiKeySchema = z.object({
  /** Row identity (UUID). The name is the human handle; this never changes. */
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
  /** Null = active. Revoked rows stay listed — they are the rotation history. */
  revokedAt: z.iso.datetime().nullable(),
});

export type ApiKey = z.infer<typeof apiKeySchema>;

/**
 * createApiKey(name) — mints a key and returns the token exactly once. The
 * ledger stores only its sha256, so no later call can ever reveal it again.
 * A second active key under the same name is refused with a 409: two live
 * credentials answering to one name is a rotation mistake, not a goal.
 */
export const createApiKeyRequestSchema = z.object({
  name: apiKeyNameSchema,
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
 * revokeApiKey(name) — soft-revokes the active key under this name: the row
 * stays as history, the credential stops opening doors on the next request.
 * Idempotent like destroySandbox: "no active key under this name" is the
 * desired end state, so an unknown or already-revoked name answers
 * { revoked: false } rather than an error. Callers should say that false
 * out loud — a typo here would leave a leaked key alive.
 */
export const revokeApiKeyRequestSchema = z.object({
  name: apiKeyNameSchema,
});

export type RevokeApiKeyRequest = z.infer<typeof revokeApiKeyRequestSchema>;

export const revokeApiKeyResponseSchema = z.object({
  /** True when an active key existed and was revoked; false when none did. */
  revoked: z.boolean(),
});

export type RevokeApiKeyResponse = z.infer<typeof revokeApiKeyResponseSchema>;
