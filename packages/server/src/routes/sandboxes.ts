import { randomUUID } from 'node:crypto';
import {
  acquireRequestSchema,
  acquireResponseSchema,
  type LifecyclePolicy,
  listSandboxesResponseSchema,
  releaseSandboxRequestSchema,
  releaseSandboxResponseSchema,
  type Sandbox,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ZodError, z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/db';
import {
  createSandbox,
  findByUserKey,
  listSandboxes,
  touch,
} from '../db/ledger';
import type { SandboxRow } from '../db/schema';
import type { Executor } from '../executor/executor';
import { releaseSandbox, wakeSandbox } from '../lifecycle';
import { resolvePolicy } from '../policy';

export interface SandboxRoutesOptions {
  config: Config;
  db: Db;
  executor: Executor;
}

/** Ledger row -> wire shape: nest the flat policy columns, attach the endpoint. */
function toSandbox(row: SandboxRow, endpoint: string): Sandbox {
  return {
    sandboxId: row.sandboxId,
    userKey: row.userKey,
    state: row.state,
    nodeId: row.nodeId,
    endpoint,
    policy: {
      freezeAfterSeconds: row.freezeAfterSeconds,
      stopAfterSeconds: row.stopAfterSeconds,
      archiveAfterSeconds: row.archiveAfterSeconds,
    },
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
  };
}

export const sandboxRoutes: FastifyPluginAsyncZod<
  SandboxRoutesOptions
> = async (app, { config, db, executor }) => {
  // Every sandbox lives on this daemon today, so the endpoint is our own
  // address; with sharding it may point at another node.
  const endpoint = `http://127.0.0.1:${config.DORMICE_PORT}`;

  // Native API convention: RPC style — every operation is a POST to a
  // camelCase verb route, input and output entirely in the body, route name
  // identical to the SDK method name. By construction this can never collide
  // with the E2B compatibility surface (/sandboxes/:id, /filesystem.*, ...).
  app.post(
    '/acquireSandbox',
    {
      schema: {
        body: acquireRequestSchema,
        response: {
          200: acquireResponseSchema,
          400: z.object({ message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { userKey, policy: override } = request.body;

      const existing = findByUserKey(db, userKey);
      if (existing) {
        // Wake whatever cold state it is in (a single jump back to active),
        // then refresh the idle clock — an acquire is what "activity" means.
        const awake = await wakeSandbox(db, executor, existing);
        const row = touch(db, awake.sandboxId);
        return { status: 'ready' as const, sandbox: toSandbox(row, endpoint) };
      }

      let policy: LifecyclePolicy;
      try {
        policy = resolvePolicy(override);
      } catch (error) {
        if (error instanceof ZodError) {
          // The override passed shape validation but the merged policy broke
          // the ordering rule — the caller's mistake, reported as such.
          return reply.code(400).send({
            message: `invalid lifecycle policy: ${error.issues
              .map((issue) => issue.message)
              .join('; ')}`,
          });
        }
        throw error;
      }

      // Reality first, ledger second: bring the container up, then record
      // it. If create fails, no row was written — the next acquire retries
      // from a clean slate.
      //
      // UUID, never an autoincrement (ids must survive sharding); its
      // alphabet is safe everywhere an id will land — Docker names, file
      // names, DNS labels.
      const sandboxId = randomUUID();
      await executor.create(sandboxId);
      const row = createSandbox(db, {
        sandboxId,
        userKey,
        nodeId: config.DORMICE_NODE_ID,
        policy,
      });
      return { status: 'ready' as const, sandbox: toSandbox(row, endpoint) };
    },
  );

  // The observation window: every sandbox with its current lifecycle state.
  // No input; the caller filters.
  app.post(
    '/listSandboxes',
    {
      schema: {
        response: { 200: listSandboxesResponseSchema },
      },
    },
    async () => ({
      sandboxes: listSandboxes(db).map((row) => toSandbox(row, endpoint)),
    }),
  );

  app.post(
    '/releaseSandbox',
    {
      schema: {
        body: releaseSandboxRequestSchema,
        response: { 200: releaseSandboxResponseSchema },
      },
    },
    async (request) => {
      const existing = findByUserKey(db, request.body.userKey);
      if (!existing) {
        // Idempotent like acquire: the desired end state — no sandbox under
        // this key — already holds.
        return { released: false };
      }
      await releaseSandbox(db, executor, existing.sandboxId);
      return { released: true };
    },
  );
};
