import { randomUUID } from 'node:crypto';
import {
  acquireRequestSchema,
  acquireResponseSchema,
  execCommandRequestSchema,
  execCommandResponseSchema,
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
  countSandboxes,
  createSandbox,
  findByUserKey,
  listSandboxes,
  touch,
} from '../db/ledger';
import type { SandboxRow } from '../db/schema';
import type { Executor } from '../executor/executor';
import { httpError } from '../http-error';
import type { KeyedQueue } from '../keyed-queue';
import { releaseSandbox, wakeSandbox } from '../lifecycle';
import { resolvePolicy } from '../policy';

export interface SandboxRoutesOptions {
  config: Config;
  db: Db;
  executor: Executor;
  locks: KeyedQueue;
}

/**
 * Keeps a sandbox's idle clock fresh while an exec is in flight, so the
 * scanner never freezes a container that is mid-command. Half the freeze
 * threshold (never above 10s) lands at least one touch inside every scan
 * window, down to the schema's minimum freezeAfterSeconds of 1. A vanished
 * row (released mid-exec) stops the timer — the exec itself will fail with
 * its own honest error; an unhandled throw inside setInterval would take
 * the daemon down instead.
 */
function startExecHeartbeat(
  db: Db,
  sandboxId: string,
  freezeAfterSeconds: number,
): () => void {
  const intervalMs = Math.min((freezeAfterSeconds * 1000) / 2, 10_000);
  const timer = setInterval(() => {
    try {
      touch(db, sandboxId);
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);
  return () => clearInterval(timer);
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
> = async (app, { config, db, executor, locks }) => {
  // Every sandbox lives on this daemon today, so the endpoint is our own
  // address; with sharding it may point at another node.
  const endpoint = `http://127.0.0.1:${config.DORMICE_PORT}`;

  // Both verbs run inside the key's queue slot (see KeyedQueue): each is a
  // check followed by an act with seconds of executor work in between, and
  // the scanner's cooling moves share the same slots. Serialization is also
  // what makes acquire idempotent under parallel retries — agent frameworks
  // retry the same key concurrently as a matter of course: the second
  // request queues, finds the row the first one wrote, and comes back with
  // the same sandbox instead of racing a duplicate create.
  async function findOrCreate(
    userKey: string,
    policy: LifecyclePolicy,
  ): Promise<SandboxRow> {
    const existing = findByUserKey(db, userKey);
    if (existing) {
      // Wake whatever cold state it is in (a single jump back to active),
      // then refresh the idle clock — an acquire is what "activity" means.
      const awake = await wakeSandbox(db, executor, existing);
      return touch(db, awake.sandboxId);
    }

    // The capacity check lives at the only verb that creates — wakes of
    // existing sandboxes are never blocked. Disk is the real ceiling: every
    // sandbox holds a disk image, and unbounded creation fills the host
    // until the ledger itself can no longer write.
    if (countSandboxes(db) >= config.DORMICE_MAX_SANDBOXES) {
      throw httpError(
        429,
        `sandbox limit reached (DORMICE_MAX_SANDBOXES=${config.DORMICE_MAX_SANDBOXES}) — release a sandbox or raise the limit`,
      );
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
    return createSandbox(db, {
      sandboxId,
      userKey,
      nodeId: config.DORMICE_NODE_ID,
      policy,
    });
  }

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

      // Validate the policy before taking the key's slot, so a queued
      // rejection can only come from the work itself, never from another
      // request's bad input. Also validates on the wake path: an invalid
      // override is the caller's mistake even when it would not apply, and
      // deserves a 400, not a silent ignore.
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

      const row = await locks.run(userKey, () => findOrCreate(userKey, policy));
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
    '/execCommand',
    {
      schema: {
        body: execCommandRequestSchema,
        response: { 200: execCommandResponseSchema },
      },
    },
    async (request) => {
      const { userKey, command, timeoutSeconds, cwd, env } = request.body;

      // Only the wake takes the key's queue slot — seconds of executor
      // work, the same serialization story as acquire. The exec itself
      // runs OUTSIDE the slot: a command may legally run for hours, and
      // holding the slot would block release and every other verb for its
      // whole duration. The heartbeat keeps the scanner away; a concurrent
      // release mid-exec destroys the container and this exec fails with
      // the executor's honest error — accepted, not defended against.
      const row = await locks.run(userKey, async () => {
        const existing = findByUserKey(db, userKey);
        if (!existing) {
          // exec is not a creator: an unknown key here is more likely a
          // typo than an intent to build a sandbox as a side effect.
          throw httpError(
            404,
            `no sandbox for key "${userKey}" — acquire it first`,
          );
        }
        const awake = await wakeSandbox(db, executor, existing);
        return touch(db, awake.sandboxId);
      });

      const stopHeartbeat = startExecHeartbeat(
        db,
        row.sandboxId,
        row.freezeAfterSeconds,
      );
      try {
        return await executor.exec(row.sandboxId, {
          command,
          timeoutSeconds,
          cwd,
          env,
        });
      } finally {
        stopHeartbeat();
        try {
          // The command itself was the activity: the idle countdown starts
          // when it ends, not when it started.
          touch(db, row.sandboxId);
        } catch {
          // Released mid-exec; the exec's own result or error tells the story.
        }
      }
    },
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
      const { userKey } = request.body;
      // Same slot as acquire and the scanner: two parallel releases of one
      // key queue up — the first destroys, the second re-checks and reports
      // the goal state honestly instead of tripping over a half-destroyed
      // sandbox.
      return locks.run(userKey, async () => {
        const existing = findByUserKey(db, userKey);
        if (!existing) {
          // Idempotent like acquire: the desired end state — no sandbox
          // under this key — already holds.
          return { released: false };
        }
        await releaseSandbox(db, executor, existing.sandboxId);
        return { released: true };
      });
    },
  );
};
