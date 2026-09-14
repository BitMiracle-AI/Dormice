import {
  lookupSandboxRequestSchema,
  lookupSandboxResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../db/db';
import { findById, findByName } from '../db/ledger';
import type { SandboxRow } from '../db/schema';
import { parseSignedFileQuery, sandboxOfSignedQuery } from '../e2b/signing';
import type { KeyedQueue } from '../keyed-queue';

export interface LookupRoutesOptions {
  db: Db;
  locks: KeyedQueue;
  /**
   * The signing secret behind envd tokens and signed URLs — the one key
   * that reads a bare signature back to the sandbox it speaks for.
   */
  envdSigningSecret: string;
}

/**
 * The gateway's one question on its own account: does this node hold the
 * sandbox? Named three ways — by name, by id, or by the signature of a
 * bare signed file URL (`/files?…signature=…` at the root carries no id:
 * the SDK's uploadUrl/downloadUrl build it off the API origin, and only
 * the secret that minted the sandbox's token reads the signature back —
 * e2b/signing.ts sandboxOfSignedQuery). Read-only — never wakes, never
 * touches the idle clock — and truthful about a create in flight, in two
 * steps. A row that exists answers at once, whatever its state: a
 * restoring sandbox has a row, and waiting for its slot would hold the
 * answer for the whole restore, long past the gateway's two-second
 * patience — the gateway would read a live sandbox as a node that did not
 * answer. No row means an acquire may be writing it right now (create
 * first, row second, both under the name's slot), so the answer takes the
 * slot itself and looks again: at once when the slot is free (a plain
 * no), behind the acquire when it is not. By id or by signature there is
 * no slot to wait on (slots are keyed by name), and none is needed: nobody
 * can ask about an id, or hold a signature, before the create that minted
 * it has answered.
 */
export const lookupRoutes: FastifyPluginAsyncZod<LookupRoutesOptions> = async (
  app,
  { db, locks, envdSigningSecret },
) => {
  app.post(
    '/lookupSandbox',
    {
      schema: {
        body: lookupSandboxRequestSchema,
        response: { 200: lookupSandboxResponseSchema },
      },
    },
    async (request) => {
      const query = request.body;
      const answer = (row: SandboxRow | undefined) =>
        row
          ? {
              found: true as const,
              sandbox: { id: row.id, name: row.name, state: row.state },
            }
          : { found: false as const };
      if ('signed' in query) {
        return answer(
          sandboxOfSignedQuery(
            db,
            envdSigningSecret,
            parseSignedFileQuery(query.signed.query),
            query.signed.operation,
          ),
        );
      }
      const look = () =>
        'name' in query ? findByName(db, query.name) : findById(db, query.id);
      const now = look();
      if (now !== undefined || !('name' in query)) return answer(now);
      return answer(await locks.run(query.name, async () => look()));
    },
  );
};
