import {
  type ApiKey,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  listApiKeysResponseSchema,
  revokeApiKeyRequestSchema,
  revokeApiKeyResponseSchema,
  updateApiKeyRequestSchema,
  updateApiKeyResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  createApiKey,
  findActiveApiKeyByName,
  findApiKeyById,
  listApiKeys,
  revokeApiKey,
  updateApiKey,
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
    expiresAt: row.expiresAt,
    disabledAt: row.disabledAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * API key management: mint, list, edit, revoke. Pure ledger verbs — no
 * executor, no locks. Admin-only: buildApp registers this plugin behind
 * requireAdminAuth (env token or console session; a live key gets an
 * honest 403), because a credential must not manage the credential ledger
 * it lives in. Verification itself lives in db/api-keys.ts and is
 * consulted by buildApp's identifyCredential closure, not here.
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
      const { name, expiresAt } = request.body;
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
      const { row, token } = createApiKey(db, name, expiresAt, request.actor);
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
    '/updateApiKey',
    {
      schema: {
        body: updateApiKeyRequestSchema,
        response: { 200: updateApiKeyResponseSchema },
      },
    },
    async (request) => {
      const { id, ...patch } = request.body;
      // Adjudication happens here, in order, with no await between the
      // checks and the write (better-sqlite3 is sync — they cannot race).
      const row = findApiKeyById(db, id);
      if (!row) {
        throw httpError(404, `no API key with id '${id}'`);
      }
      if (row.revokedAt !== null) {
        throw httpError(
          409,
          `API key "${row.name}" is revoked — revoked rows are rotation history and cannot be changed`,
        );
      }
      if (patch.name !== undefined && patch.name !== row.name) {
        // Same courtesy as create: the name must not collide with any
        // non-revoked key. findActiveApiKeyByName cannot return this row
        // itself — the names differ.
        if (findActiveApiKeyByName(db, patch.name)) {
          throw httpError(
            409,
            `an active API key named '${patch.name}' already exists — revoke it first or pick another name`,
          );
        }
      }
      return { apiKey: view(updateApiKey(db, row, patch, request.actor)) };
    },
  );

  app.post(
    '/revokeApiKey',
    {
      schema: {
        body: revokeApiKeyRequestSchema,
        response: { 200: revokeApiKeyResponseSchema },
      },
    },
    async (request) => ({
      revoked: revokeApiKey(db, request.body.id, request.actor),
    }),
  );
};
