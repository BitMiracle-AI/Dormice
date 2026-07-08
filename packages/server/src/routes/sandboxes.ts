import {
  acquireRequestSchema,
  acquireResponseSchema,
  type LifecyclePolicy,
  type Sandbox,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { nanoid } from 'nanoid';
import { ZodError, z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/db';
import { createSandbox, findByUserKey, touch } from '../db/ledger';
import type { SandboxRow } from '../db/schema';
import type { Executor } from '../executor/executor';
import { wakeSandbox } from '../lifecycle';
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
      const sandboxId = nanoid();
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
};
