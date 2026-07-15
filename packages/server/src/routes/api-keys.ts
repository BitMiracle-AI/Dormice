import {
  type ApiKey,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  listApiKeysResponseSchema,
  revokeApiKeyRequestSchema,
  revokeApiKeyResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  createApiKey,
  findActiveApiKeyByName,
  listApiKeys,
  revokeApiKey,
} from '../db/api-keys';
import type { Db } from '../db/db';
import type { ApiKeyRow } from '../db/schema';
import { httpError } from '../http-error';

export interface ApiKeyRoutesOptions {
  db: Db;
}

/** The wire view: everything but the hash — no secret ever leaves the row. */
function view(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * API key management: mint, list, revoke. Pure ledger verbs — no executor,
 * no locks — sitting behind the same auth they extend: the first key is
 * minted with the env token (or a console session), later ones with any
 * live key. Verification itself lives in db/api-keys.ts and is consulted
 * by buildApp's verifyCredential closure, not here.
 */
export const apiKeyRoutes: FastifyPluginAsyncZod<ApiKeyRoutesOptions> = async (
  app,
  { db },
) => {
  app.post(
    '/createApiKey',
    {
      schema: {
        body: createApiKeyRequestSchema,
        response: { 200: createApiKeyResponseSchema },
      },
    },
    async (request) => {
      const { name } = request.body;
      // Two live credentials answering to one name is a rotation mistake,
      // not a goal — refused by name, like removeTemplate's 409. The
      // partial unique index backstops this check as a schema fact; no
      // await sits between check and insert, so they cannot race.
      if (findActiveApiKeyByName(db, name)) {
        throw httpError(
          409,
          `an active API key named '${name}' already exists — revoke it first or pick another name`,
        );
      }
      const { row, token } = createApiKey(db, name);
      return { apiKey: view(row), token };
    },
  );

  app.post(
    '/listApiKeys',
    {
      schema: {
        response: { 200: listApiKeysResponseSchema },
      },
    },
    async () => ({ apiKeys: listApiKeys(db).map(view) }),
  );

  app.post(
    '/revokeApiKey',
    {
      schema: {
        body: revokeApiKeyRequestSchema,
        response: { 200: revokeApiKeyResponseSchema },
      },
    },
    async (request) => ({ revoked: revokeApiKey(db, request.body.name) }),
  );
};
