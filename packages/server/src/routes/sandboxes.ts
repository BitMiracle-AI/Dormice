import { randomUUID } from 'node:crypto';
import {
  acquireRequestSchema,
  acquireResponseSchema,
  execCommandRequestSchema,
  execCommandResponseSchema,
  getSandboxMetricsRequestSchema,
  getSandboxMetricsResponseSchema,
  type LifecyclePolicy,
  lifecyclePolicySchema,
  listSandboxesResponseSchema,
  readFileRequestSchema,
  readFileResponseSchema,
  rebuildSandboxRequestSchema,
  rebuildSandboxResponseSchema,
  releaseSandboxRequestSchema,
  releaseSandboxResponseSchema,
  resolveSandboxPath,
  type Sandbox,
  setPolicyRequestSchema,
  setPolicyResponseSchema,
  WRITE_FILES_BODY_LIMIT_BYTES,
  writeFilesRequestSchema,
  writeFilesResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ZodError, z } from 'zod';
import type { Archiver, RestoreProgress } from '../archive/archiver';
import type { Config } from '../config';
import { recordActivity } from '../db/activity';
import type { Db } from '../db/db';
import {
  countSandboxes,
  createSandbox,
  findByUserKey,
  listSandboxes,
  touch,
  updatePolicy,
} from '../db/ledger';
import type { SandboxRow } from '../db/schema';
import { findTemplate, resolveImage } from '../db/templates';
import { startExecHeartbeat } from '../exec-heartbeat';
import {
  type Executor,
  FileNotFoundError,
  FileTooLargeError,
  NotAFileError,
} from '../executor/executor';
import { httpError } from '../http-error';
import type { KeyedQueue } from '../keyed-queue';
import { rebuildSandbox, releaseSandbox, wakeSandbox } from '../lifecycle';
import { ArchiveDisabledError, resolvePolicy } from '../policy';

export interface SandboxRoutesOptions {
  config: Config;
  db: Db;
  executor: Executor;
  locks: KeyedQueue;
  /** Absent = no S3 configured: archiving and restores are honestly off. */
  archiver?: Archiver;
  /** buildApp's one adjudication of the archive policy default (null = off). */
  archiveDefaultSeconds: number | null;
}

/** What acquire's slot work resolves to — the wire union's two arms. */
type AcquireOutcome =
  | { status: 'ready'; row: SandboxRow }
  | { status: 'restoring'; row: SandboxRow; progress: RestoreProgress };

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
    template: row.template,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
  };
}

export const sandboxRoutes: FastifyPluginAsyncZod<
  SandboxRoutesOptions
> = async (
  app,
  { config, db, executor, locks, archiver, archiveDefaultSeconds },
) => {
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
    template: string | null,
  ): Promise<AcquireOutcome> {
    const existing = findByUserKey(db, userKey);
    if (existing?.state === 'archived' || existing?.state === 'restoring') {
      // The protocol's promise: acquire never blocks on a slow wake-up. An
      // archived sandbox starts its restore and answers `restoring` with
      // progress at once; the caller polls acquire until it flips to ready.
      if (!archiver) {
        throw httpError(
          503,
          `sandbox for key "${userKey}" is ${existing.state} but the daemon has no S3 configured (DORMICE_S3_*) — restore is impossible until it is`,
        );
      }
      if (existing.state === 'archived') {
        archiver.beginRestore(existing);
      }
      const restoring = findByUserKey(db, userKey);
      if (!restoring) {
        throw httpError(500, `sandbox for key "${userKey}" vanished mid-slot`);
      }
      return {
        status: 'restoring',
        row: restoring,
        // The fallback covers the crash-zombie instant before the next
        // reconcile flips the row back to archived; at runtime a restoring
        // row always has a live task.
        progress: archiver.progressOf(existing.sandboxId) ?? {
          phase: 'downloading',
          percent: 0,
        },
      };
    }
    if (existing) {
      // Wake whatever cold state it is in (a single jump back to active),
      // then refresh the idle clock — an acquire is what "activity" means.
      // A requested template is not applied: like policy, it takes effect
      // only when this acquire creates the sandbox.
      const awake = await wakeSandbox(db, executor, existing);
      return { status: 'ready', row: touch(db, awake.sandboxId) };
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
    await executor.create(sandboxId, { image: resolveImage(db, template) });
    return {
      status: 'ready',
      row: createSandbox(db, {
        sandboxId,
        userKey,
        nodeId: config.DORMICE_NODE_ID,
        policy,
        template,
      }),
    };
  }

  // Shared by every verb that uses an existing sandbox (exec, file ops):
  // 404 for an unknown key — these verbs are not creators, an unknown key
  // is more likely a typo than an intent to build a sandbox as a side
  // effect — then wake whatever cold state the sandbox is in and refresh
  // its idle clock. Must be called while holding the key's queue slot.
  async function wakeForUse(userKey: string): Promise<SandboxRow> {
    const existing = findByUserKey(db, userKey);
    if (!existing) {
      throw httpError(
        404,
        `no sandbox for key "${userKey}" — acquire it first`,
      );
    }
    if (existing.state === 'archived' || existing.state === 'restoring') {
      // The native restore path is acquire's poll loop; a use verb neither
      // blocks for minutes nor starts restores on the side.
      throw httpError(
        409,
        `sandbox for key "${userKey}" is ${existing.state} — call acquireSandbox and poll until it is ready`,
      );
    }
    const awake = await wakeSandbox(db, executor, existing);
    return touch(db, awake.sandboxId);
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
      const { userKey, policy: override, template } = request.body;

      // Validate the policy before taking the key's slot, so a queued
      // rejection can only come from the work itself, never from another
      // request's bad input. Also validates on the wake path: an invalid
      // override is the caller's mistake even when it would not apply, and
      // deserves a 400, not a silent ignore.
      let policy: LifecyclePolicy;
      try {
        policy = resolvePolicy(override, archiveDefaultSeconds);
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
        if (error instanceof ArchiveDisabledError) {
          return reply.code(400).send({
            message: `invalid lifecycle policy: ${error.message}`,
          });
        }
        throw error;
      }

      // Same placement as the policy check: an unknown template is the
      // caller's mistake and answers 400 before the slot, on the wake path
      // too — never silently ignored.
      if (template !== undefined && !findTemplate(db, template)) {
        return reply.code(400).send({
          message: `unknown template '${template}' — register it first`,
        });
      }

      const outcome = await locks.run(userKey, () =>
        findOrCreate(userKey, policy, template ?? null),
      );
      if (outcome.status === 'restoring') {
        return {
          status: 'restoring' as const,
          sandbox: toSandbox(outcome.row, endpoint),
          progress: outcome.progress,
        };
      }
      return {
        status: 'ready' as const,
        sandbox: toSandbox(outcome.row, endpoint),
      };
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

  // One sandbox's point-in-time resource reading — the native twin of the
  // E2B metrics endpoint, same rules: a single sample (no history kept),
  // and observation never wakes anything. A frozen sandbox is measured as
  // it sleeps (its cgroup accounting stays readable); with no running
  // container there is nothing to measure and the answer is an honest null.
  app.post(
    '/getSandboxMetrics',
    {
      schema: {
        body: getSandboxMetricsRequestSchema,
        response: { 200: getSandboxMetricsResponseSchema },
      },
    },
    async (request) => {
      const { userKey } = request.body;
      const row = findByUserKey(db, userKey);
      if (!row) {
        throw httpError(
          404,
          `no sandbox for key "${userKey}" — acquire it first`,
        );
      }
      if (row.state !== 'active' && row.state !== 'frozen') {
        return { sample: null };
      }
      const m = await executor.metrics(row.sandboxId);
      return { sample: { timestamp: new Date().toISOString(), ...m } };
    },
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
      const row = await locks.run(userKey, () => wakeForUse(userKey));

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

  // Maps the executor's typed file errors onto HTTP, message untouched.
  function throwFileHttpError(error: unknown): never {
    if (error instanceof FileNotFoundError) throw httpError(404, error.message);
    if (error instanceof NotAFileError) throw httpError(400, error.message);
    if (error instanceof FileTooLargeError) throw httpError(413, error.message);
    throw error;
  }

  // Both file verbs run ENTIRELY inside the key's queue slot, unlike exec:
  // a file operation's work is bounded (16 MiB against a local ext4 —
  // seconds at worst), so holding the slot is cheap and buys the same
  // guarantees acquire enjoys — the scanner cannot freeze the sandbox
  // mid-write and a concurrent release queues up behind us instead of
  // destroying the container under our feet. No heartbeat needed.
  app.post(
    '/writeFiles',
    {
      // The one total gate for a batch; per-file size is the schema's job.
      bodyLimit: WRITE_FILES_BODY_LIMIT_BYTES,
      schema: {
        body: writeFilesRequestSchema,
        response: { 200: writeFilesResponseSchema },
      },
    },
    async (request) => {
      const { userKey, files } = request.body;
      return locks.run(userKey, async () => {
        const row = await wakeForUse(userKey);
        try {
          await executor.writeFiles(
            row.sandboxId,
            files.map((file) => ({
              path: file.path,
              content: Buffer.from(file.contentBase64, 'base64'),
            })),
          );
        } catch (error) {
          throwFileHttpError(error);
        }
        touch(db, row.sandboxId);
        return {
          files: files.map((file) => ({ path: resolveSandboxPath(file.path) })),
        };
      });
    },
  );

  app.post(
    '/readFile',
    {
      schema: {
        body: readFileRequestSchema,
        response: { 200: readFileResponseSchema },
      },
    },
    async (request) => {
      const { userKey, path } = request.body;
      return locks.run(userKey, async () => {
        const row = await wakeForUse(userKey);
        let content: Buffer;
        try {
          content = await executor.readFile(row.sandboxId, path);
        } catch (error) {
          throwFileHttpError(error);
        }
        touch(db, row.sandboxId);
        return {
          path: resolveSandboxPath(path),
          contentBase64: content.toString('base64'),
        };
      });
    },
  );

  app.post(
    '/rebuildSandbox',
    {
      schema: {
        body: rebuildSandboxRequestSchema,
        response: { 200: rebuildSandboxResponseSchema },
      },
    },
    async (request) => {
      const { userKey } = request.body;
      // The whole verb holds the key's slot, like the file verbs: seconds of
      // executor work at worst, and the slot keeps the scanner and a
      // concurrent release from moving the sandbox under our feet.
      return locks.run(userKey, async () => {
        const existing = findByUserKey(db, userKey);
        if (!existing) {
          // Not a creator and not a destroyer: an unknown key is a typo,
          // not a goal state — same manners as exec.
          throw httpError(
            404,
            `no sandbox for key "${userKey}" — acquire it first`,
          );
        }
        if (existing.state === 'archived' || existing.state === 'restoring') {
          // An archived sandbox has no container to swap; it already meets
          // rebuild's promise (its next wake builds from the current image).
          throw httpError(
            409,
            `sandbox for key "${userKey}" is ${existing.state} — it has no container to rebuild`,
          );
        }
        const row = await rebuildSandbox(db, executor, existing);
        return { sandbox: toSandbox(row, endpoint) };
      });
    },
  );

  app.post(
    '/setPolicy',
    {
      schema: {
        body: setPolicyRequestSchema,
        response: {
          200: setPolicyResponseSchema,
          400: z.object({ message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { userKey, policy: patch } = request.body;
      // Unlike acquire, the merge base is the STORED policy, so validation
      // must wait for the row — it runs inside the slot, which also keeps a
      // concurrent release from deleting the row between check and write.
      const outcome = await locks.run<{ error: string } | { row: SandboxRow }>(
        userKey,
        async () => {
          const existing = findByUserKey(db, userKey);
          if (!existing) {
            // Not a creator: an unknown key is a typo, same manners as rebuild.
            throw httpError(
              404,
              `no sandbox for key "${userKey}" — acquire it first`,
            );
          }
          // Legal in every state: policy is a ledger attribute, not a container
          // one — even an archived sandbox's thresholds matter after restore.
          const merged = lifecyclePolicySchema.safeParse({
            freezeAfterSeconds:
              patch.freezeAfterSeconds ?? existing.freezeAfterSeconds,
            stopAfterSeconds:
              patch.stopAfterSeconds !== undefined
                ? patch.stopAfterSeconds
                : existing.stopAfterSeconds,
            archiveAfterSeconds:
              patch.archiveAfterSeconds !== undefined
                ? patch.archiveAfterSeconds
                : existing.archiveAfterSeconds,
          });
          if (!merged.success) {
            return {
              error: `invalid lifecycle policy: ${merged.error.issues
                .map((issue) => issue.message)
                .join('; ')}`,
            };
          }
          if (
            archiveDefaultSeconds === null &&
            merged.data.archiveAfterSeconds !== null
          ) {
            return {
              error:
                'invalid lifecycle policy: archiving requires S3 (DORMICE_S3_*) to be configured',
            };
          }
          const before = {
            freezeAfterSeconds: existing.freezeAfterSeconds,
            stopAfterSeconds: existing.stopAfterSeconds,
            archiveAfterSeconds: existing.archiveAfterSeconds,
          } as const;
          const changed = (
            [
              'freezeAfterSeconds',
              'stopAfterSeconds',
              'archiveAfterSeconds',
            ] as const
          ).filter((knob) => before[knob] !== merged.data[knob]);
          if (changed.length === 0) {
            // The goal state already holds; a no-op writes no history.
            return { row: existing };
          }
          const row = updatePolicy(db, existing.sandboxId, merged.data);
          const fmt = (seconds: number | null) =>
            seconds === null ? 'never' : `${seconds}s`;
          recordActivity(db, {
            kind: 'policy-changed',
            userKey,
            sandboxId: row.sandboxId,
            detail: changed
              .map(
                (knob) =>
                  `${knob.replace('AfterSeconds', '')} ${fmt(before[knob])} -> ${fmt(merged.data[knob])}`,
              )
              .join(', '),
          });
          return { row };
        },
      );
      if ('error' in outcome) {
        return reply.code(400).send({ message: outcome.error });
      }
      return { sandbox: toSandbox(outcome.row, endpoint) };
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
        if (existing.state === 'restoring') {
          // The one documented dent in release's idempotence: tearing the
          // half-built disk down would race the restore task over it. The
          // task finishes in seconds to minutes; retry then.
          throw httpError(409, 'sandbox is restoring; retry when it finishes');
        }
        await releaseSandbox(
          db,
          executor,
          existing.sandboxId,
          archiver?.store ?? null,
        );
        return { released: true };
      });
    },
  );
};
