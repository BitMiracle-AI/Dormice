import { randomUUID } from 'node:crypto';
import {
  acquireRequestSchema,
  acquireResponseSchema,
  destroySandboxRequestSchema,
  destroySandboxResponseSchema,
  execCommandRequestSchema,
  execCommandResponseSchema,
  getSandboxMetricsHistoryRequestSchema,
  getSandboxMetricsHistoryResponseSchema,
  getSandboxMetricsRequestSchema,
  getSandboxMetricsResponseSchema,
  type LifecyclePolicy,
  lifecyclePolicySchema,
  listSandboxesResponseSchema,
  listSandboxImagesRequestSchema,
  listSandboxImagesResponseSchema,
  listSandboxMetricsRequestSchema,
  listSandboxMetricsResponseSchema,
  READ_FILES_TOTAL_LIMIT_BYTES,
  readFileRequestSchema,
  readFileResponseSchema,
  readFilesRequestSchema,
  readFilesResponseSchema,
  rebuildSandboxRequestSchema,
  rebuildSandboxResponseSchema,
  resolveSandboxPath,
  type Sandbox,
  type SandboxMetadata,
  updateMetadataRequestSchema,
  updateMetadataResponseSchema,
  updatePolicyRequestSchema,
  updatePolicyResponseSchema,
  WRITE_FILES_BODY_LIMIT_BYTES,
  writeFileRequestSchema,
  writeFileResponseSchema,
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
  findByName,
  listSandboxes,
  touch,
  updateMetadata,
  updatePolicy,
} from '../db/ledger';
import {
  bucketSamples,
  querySandboxSamples,
  resolveBucketSeconds,
  resolveWindow,
} from '../db/metrics';
import type { SandboxRow } from '../db/schema';
import { readRuntimeSettings } from '../db/settings';
import { findTemplate, resolveImage } from '../db/templates';
import type { WatcherTable } from '../e2b/watcher-table';
import { startExecHeartbeat } from '../exec-heartbeat';
import {
  type Executor,
  FileNotFoundError,
  FileTooLargeError,
  NotAFileError,
} from '../executor/executor';
import { httpError } from '../http-error';
import type { KeyedQueue } from '../keyed-queue';
import { destroySandbox, rebuildSandbox, wakeSandbox } from '../lifecycle';
import { ArchiveDisabledError, resolvePolicy } from '../policy';

export interface SandboxRoutesOptions {
  config: Config;
  db: Db;
  executor: Executor;
  locks: KeyedQueue;
  watchers: WatcherTable;
  /** Absent = no S3 configured: archiving and restores are honestly off. */
  archiver?: Archiver;
  /** buildApp's one adjudication of the archive policy default (null = off). */
  archiveDefaultSeconds: number | null;
}

/** What acquire's slot work resolves to — the wire union's two arms. */
type AcquireOutcome =
  /** `created` — names converge instead of erroring, so this flag is how a caller sees which happened. */
  | { status: 'ready'; created: boolean; row: SandboxRow }
  | { status: 'restoring'; row: SandboxRow; progress: RestoreProgress };

/** Ledger row -> wire shape: nest the flat policy columns, attach the endpoint. */
function toSandbox(row: SandboxRow, endpoint: string): Sandbox {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    nodeId: row.nodeId,
    endpoint,
    policy: {
      freezeAfterSeconds: row.freezeAfterSeconds,
      stopAfterSeconds: row.stopAfterSeconds,
      archiveAfterSeconds: row.archiveAfterSeconds,
    },
    template: row.template,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
  };
}

/**
 * Label map -> column value. An empty set is stored as NULL, not "{}": the
 * column has meant "no labels = NULL" since the E2B surface introduced it,
 * and the view normalizes both spellings to {} anyway.
 */
function serializeMetadata(
  metadata: SandboxMetadata | undefined,
): string | null {
  return metadata && Object.keys(metadata).length > 0
    ? JSON.stringify(metadata)
    : null;
}

export const sandboxRoutes: FastifyPluginAsyncZod<
  SandboxRoutesOptions
> = async (
  app,
  { config, db, executor, locks, watchers, archiver, archiveDefaultSeconds },
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
    name: string,
    policy: LifecyclePolicy,
    template: string | null,
    metadata: string | null,
    actor: string | null,
  ): Promise<AcquireOutcome> {
    const existing = findByName(db, name);
    if (existing?.state === 'archived' || existing?.state === 'restoring') {
      // The protocol's promise: acquire never blocks on a slow wake-up. An
      // archived sandbox starts its restore and answers `restoring` with
      // progress at once; the caller polls acquire until it flips to ready.
      if (!archiver) {
        throw httpError(
          503,
          `sandbox "${name}" is ${existing.state} but the daemon has no S3 configured (DORMICE_S3_*) — restore is impossible until it is`,
        );
      }
      if (existing.state === 'archived') {
        archiver.beginRestore(existing);
      }
      const restoring = findByName(db, name);
      if (!restoring) {
        throw httpError(500, `sandbox "${name}" vanished mid-slot`);
      }
      return {
        status: 'restoring',
        row: restoring,
        // The fallback covers the crash-zombie instant before the next
        // reconcile flips the row back to archived; at runtime a restoring
        // row always has a live task.
        progress: archiver.progressOf(existing.id) ?? {
          phase: 'downloading',
          percent: 0,
        },
      };
    }
    if (existing) {
      // Wake whatever cold state it is in (a single jump back to active),
      // then refresh the idle clock — an acquire is what "activity" means.
      // Requested template and metadata are not applied: like policy, they
      // take effect only when this acquire creates the sandbox (metadata
      // has its own update verb, updateMetadata).
      const awake = await wakeSandbox(db, executor, existing, actor, watchers);
      return { status: 'ready', created: false, row: touch(db, awake.id) };
    }

    // The capacity check lives at the only verb that creates — wakes of
    // existing sandboxes are never blocked. Disk is the real ceiling: every
    // sandbox holds a disk image, and unbounded creation fills the host
    // until the ledger itself can no longer write. Read live from the
    // ledger: a console edit applies to the very next create.
    const maxSandboxes = readRuntimeSettings(db).maxSandboxes;
    if (countSandboxes(db) >= maxSandboxes) {
      throw httpError(
        429,
        `sandbox limit reached (maxSandboxes=${maxSandboxes}) — destroy a sandbox or raise the limit in settings`,
      );
    }

    // Reality first, ledger second: bring the container up, then record
    // it. If create fails, no row was written — the next acquire retries
    // from a clean slate.
    //
    // UUID, never an autoincrement (ids must survive sharding); its
    // alphabet is safe everywhere an id will land — Docker names, file
    // names, DNS labels.
    const id = randomUUID();
    await executor.create(id, { image: resolveImage(db, template) });
    return {
      status: 'ready',
      created: true,
      row: createSandbox(db, {
        id,
        name,
        nodeId: config.DORMICE_NODE_ID,
        policy,
        template,
        metadata,
        actor,
      }),
    };
  }

  // Shared by every verb that uses an existing sandbox (exec, file ops):
  // 404 for an unknown key — these verbs are not creators, an unknown key
  // is more likely a typo than an intent to build a sandbox as a side
  // effect — then wake whatever cold state the sandbox is in and refresh
  // its idle clock. Must be called while holding the key's queue slot.
  async function wakeForUse(
    name: string,
    actor: string | null,
  ): Promise<SandboxRow> {
    const existing = findByName(db, name);
    if (!existing) {
      throw httpError(404, `no sandbox named "${name}" — acquire it first`);
    }
    if (existing.state === 'archived' || existing.state === 'restoring') {
      // The native restore path is acquire's poll loop; a use verb neither
      // blocks for minutes nor starts restores on the side.
      throw httpError(
        409,
        `sandbox "${name}" is ${existing.state} — call acquireSandbox and poll until it is ready`,
      );
    }
    const awake = await wakeSandbox(db, executor, existing, actor, watchers);
    return touch(db, awake.id);
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
      const { name, policy: override, template, metadata } = request.body;

      // Validate the policy before taking the key's slot, so a queued
      // rejection can only come from the work itself, never from another
      // request's bad input. Also validates on the wake path: an invalid
      // override is the caller's mistake even when it would not apply, and
      // deserves a 400, not a silent ignore.
      let policy: LifecyclePolicy;
      try {
        policy = resolvePolicy(
          override,
          readRuntimeSettings(db).defaultPolicy,
          archiveDefaultSeconds !== null,
        );
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

      const outcome = await locks.run(name, () =>
        findOrCreate(
          name,
          policy,
          template ?? null,
          serializeMetadata(metadata),
          request.actor,
        ),
      );
      if (outcome.status === 'restoring') {
        return {
          status: 'restoring' as const,
          // Only an already-archived sandbox restores — never a fresh one.
          created: false,
          sandbox: toSandbox(outcome.row, endpoint),
          progress: outcome.progress,
        };
      }
      return {
        status: 'ready' as const,
        created: outcome.created,
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
  // E2B metrics endpoint. Observation never wakes anything: a frozen
  // sandbox is measured as it sleeps (its cgroup accounting stays
  // readable); with no running container there is nothing to measure and
  // the answer is an honest null. The past lives one verb down, in
  // getSandboxMetricsHistory.
  app.post(
    '/getSandboxMetrics',
    {
      schema: {
        body: getSandboxMetricsRequestSchema,
        response: { 200: getSandboxMetricsResponseSchema },
      },
    },
    async (request) => {
      const { name } = request.body;
      const row = findByName(db, name);
      if (!row) {
        throw httpError(404, `no sandbox named "${name}" — acquire it first`);
      }
      if (row.state !== 'active' && row.state !== 'frozen') {
        return { sample: null };
      }
      const m = await executor.metrics(row.id);
      return { sample: { timestamp: new Date().toISOString(), ...m } };
    },
  );

  // The sampled past of one sandbox, sliced by an optional ISO window
  // (default: the last hour) and bucketed past 360 points — each bucket
  // reporting per-field maxima, because history readers hunt spikes and
  // averages erase them. An unsampled window answers an empty array; the
  // native face never takes a live reading to fill silence (the E2B face
  // does, as compatibility politeness — the asymmetry is deliberate).
  // History is keyed by the sandbox id under the hood, so it survives rebuilds.
  app.post(
    '/getSandboxMetricsHistory',
    {
      schema: {
        body: getSandboxMetricsHistoryRequestSchema,
        response: { 200: getSandboxMetricsHistoryResponseSchema },
      },
    },
    async (request) => {
      const { name, start, end } = request.body;
      const row = findByName(db, name);
      if (!row) {
        throw httpError(404, `no sandbox named "${name}" — acquire it first`);
      }
      const { startIso, endIso, startMs, endMs } = resolveWindow(
        start,
        end,
        3600_000,
        new Date(),
      );
      const rows = querySandboxSamples(db, row.id, startIso, endIso);
      const bucketSeconds = resolveBucketSeconds(rows.length, startMs, endMs);
      const sliced =
        bucketSeconds === null
          ? rows
          : bucketSamples(rows, startMs, bucketSeconds);
      return {
        samples: sliced.map(({ sandboxId: _, at, ...metrics }) => ({
          timestamp: at,
          ...metrics,
        })),
        bucketSeconds,
      };
    },
  );

  // Every measurable sandbox in one answer: the list view's food. Readings
  // run in parallel because one docker-stats sample costs about a second —
  // serial would scale the answer with the fleet. Presence means measured:
  // colder states are absent (same honesty as getSandboxMetrics's null),
  // and a container that vanishes mid-reading is skipped, not invented —
  // any code must expect containers to disappear at any moment.
  app.post(
    '/listSandboxMetrics',
    {
      schema: {
        body: listSandboxMetricsRequestSchema,
        response: { 200: listSandboxMetricsResponseSchema },
      },
    },
    async () => {
      const rows = listSandboxes(db).filter(
        (row) => row.state === 'active' || row.state === 'frozen',
      );
      const samples = await Promise.all(
        rows.map(async (row) => {
          try {
            const m = await executor.metrics(row.id);
            return {
              sandboxName: row.name,
              sandboxId: row.id,
              sample: { timestamp: new Date().toISOString(), ...m },
            };
          } catch {
            return null;
          }
        }),
      );
      return { samples: samples.filter((s) => s !== null) };
    },
  );

  // Every sandbox's image lineage in one answer: which image the current
  // shell was born from, next to what the next shell would boot. The born
  // image is a property of the shell and deliberately not a ledger column,
  // so it is read from reality on demand — in parallel, like the metrics
  // batch above. Rows that cannot have a container (archived, restoring)
  // skip the executor call outright; for the rest a vanished container
  // reads as null, not a guess. Observation never wakes anything.
  app.post(
    '/listSandboxImages',
    {
      schema: {
        body: listSandboxImagesRequestSchema,
        response: { 200: listSandboxImagesResponseSchema },
      },
    },
    async () => {
      const images = await Promise.all(
        listSandboxes(db).map(async (row) => {
          // resolveImage is the one arbiter of template -> image; undefined
          // means "the executor's own base image", and the executor is the
          // one authority on what that is (config only knows in docker mode).
          const nextImage =
            resolveImage(db, row.template) ?? executor.baseImage;
          let image: string | null = null;
          if (row.state !== 'archived' && row.state !== 'restoring') {
            try {
              image = await executor.imageOf(row.id);
            } catch {
              // Reading failed mid-vanish: no shell to report, same as null.
              image = null;
            }
          }
          return {
            sandboxName: row.name,
            sandboxId: row.id,
            image,
            nextImage,
            // A row without a shell is not upgradable: its very next boot
            // resolves the current image by itself. rebuildSandbox is the
            // front door for the rest.
            upgradable: image !== null && image !== nextImage,
          };
        }),
      );
      return { images };
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
      const { name, command, timeoutSeconds, cwd, env } = request.body;

      // Only the wake takes the key's queue slot — seconds of executor
      // work, the same serialization story as acquire. The exec itself
      // runs OUTSIDE the slot: a command may legally run for hours, and
      // holding the slot would block destroy and every other verb for its
      // whole duration. The heartbeat keeps the scanner away; a concurrent
      // destroy mid-exec removes the container and this exec fails with
      // the executor's honest error — accepted, not defended against.
      const row = await locks.run(name, () => wakeForUse(name, request.actor));

      const stopHeartbeat = startExecHeartbeat(
        db,
        row.id,
        row.freezeAfterSeconds,
      );
      try {
        return await executor.exec(row.id, {
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
          touch(db, row.id);
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

  // The file verbs run ENTIRELY inside the key's queue slot, unlike exec:
  // a file operation's work is bounded (48 MiB against a local ext4 —
  // seconds at worst), so holding the slot is cheap and buys the same
  // guarantees acquire enjoys — the scanner cannot freeze the sandbox
  // mid-write and a concurrent destroy queues up behind us instead of
  // removing the container under our feet. No heartbeat needed.
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
      const { name, files } = request.body;
      return locks.run(name, async () => {
        const row = await wakeForUse(name, request.actor);
        try {
          await executor.writeFiles(
            row.id,
            files.map((file) => ({
              path: file.path,
              content: Buffer.from(file.contentBase64, 'base64'),
            })),
          );
        } catch (error) {
          throwFileHttpError(error);
        }
        touch(db, row.id);
        return {
          files: files.map((file) => ({ path: resolveSandboxPath(file.path) })),
        };
      });
    },
  );

  // The single-file form of writeFiles: same slot, same executor call, no
  // array ceremony. The transport gate is shared with the batch — the
  // schema's per-file cap is the real limit.
  app.post(
    '/writeFile',
    {
      bodyLimit: WRITE_FILES_BODY_LIMIT_BYTES,
      schema: {
        body: writeFileRequestSchema,
        response: { 200: writeFileResponseSchema },
      },
    },
    async (request) => {
      const { name, path, contentBase64 } = request.body;
      return locks.run(name, async () => {
        const row = await wakeForUse(name, request.actor);
        try {
          await executor.writeFiles(row.id, [
            { path, content: Buffer.from(contentBase64, 'base64') },
          ]);
        } catch (error) {
          throwFileHttpError(error);
        }
        touch(db, row.id);
        return { path: resolveSandboxPath(path) };
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
      const { name, path } = request.body;
      return locks.run(name, async () => {
        const row = await wakeForUse(name, request.actor);
        let content: Buffer;
        try {
          content = await executor.readFile(row.id, path);
        } catch (error) {
          throwFileHttpError(error);
        }
        touch(db, row.id);
        return {
          path: resolveSandboxPath(path),
          contentBase64: content.toString('base64'),
        };
      });
    },
  );

  // Batch reads are all or nothing (see readFilesRequestSchema): the first
  // failing path aborts the call through throwFileHttpError, and the running
  // total is gated so a broad glob cannot buffer the daemon into the ground.
  app.post(
    '/readFiles',
    {
      schema: {
        body: readFilesRequestSchema,
        response: { 200: readFilesResponseSchema },
      },
    },
    async (request) => {
      const { name, paths } = request.body;
      return locks.run(name, async () => {
        const row = await wakeForUse(name, request.actor);
        const files: { path: string; contentBase64: string }[] = [];
        let totalBytes = 0;
        for (const path of paths) {
          let content: Buffer;
          try {
            content = await executor.readFile(row.id, path);
          } catch (error) {
            throwFileHttpError(error);
          }
          totalBytes += content.length;
          if (totalBytes > READ_FILES_TOTAL_LIMIT_BYTES) {
            throw httpError(
              413,
              `readFiles batch exceeds the ${READ_FILES_TOTAL_LIMIT_BYTES}-byte total limit at "${resolveSandboxPath(path)}" — split it into smaller calls`,
            );
          }
          files.push({
            path: resolveSandboxPath(path),
            contentBase64: content.toString('base64'),
          });
        }
        touch(db, row.id);
        return { files };
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
      const { name } = request.body;
      // The whole verb holds the key's slot, like the file verbs: seconds of
      // executor work at worst, and the slot keeps the scanner and a
      // concurrent destroy from moving the sandbox under our feet.
      return locks.run(name, async () => {
        const existing = findByName(db, name);
        if (!existing) {
          // Not a creator and not a destroyer: an unknown key is a typo,
          // not a goal state — same manners as exec.
          throw httpError(404, `no sandbox named "${name}" — acquire it first`);
        }
        if (existing.state === 'archived' || existing.state === 'restoring') {
          // An archived sandbox has no container to swap; it already meets
          // rebuild's promise (its next wake builds from the current image).
          throw httpError(
            409,
            `sandbox "${name}" is ${existing.state} — it has no container to rebuild`,
          );
        }
        const row = await rebuildSandbox(
          db,
          executor,
          existing,
          request.actor,
          undefined,
          watchers,
        );
        return { sandbox: toSandbox(row, endpoint) };
      });
    },
  );

  app.post(
    '/updatePolicy',
    {
      schema: {
        body: updatePolicyRequestSchema,
        response: {
          200: updatePolicyResponseSchema,
          400: z.object({ message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { name, policy: patch } = request.body;
      // Unlike acquire, the merge base is the STORED policy, so validation
      // must wait for the row — it runs inside the slot, which also keeps a
      // concurrent destroy from deleting the row between check and write.
      const outcome = await locks.run<{ error: string } | { row: SandboxRow }>(
        name,
        async () => {
          const existing = findByName(db, name);
          if (!existing) {
            // Not a creator: an unknown key is a typo, same manners as rebuild.
            throw httpError(
              404,
              `no sandbox named "${name}" — acquire it first`,
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
          const row = updatePolicy(db, existing.id, merged.data);
          const fmt = (seconds: number | null) =>
            seconds === null ? 'never' : `${seconds}s`;
          recordActivity(db, {
            kind: 'policy-changed',
            sandboxName: name,
            sandboxId: row.id,
            actor: request.actor,
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
    '/updateMetadata',
    {
      schema: {
        body: updateMetadataRequestSchema,
        response: { 200: updateMetadataResponseSchema },
      },
    },
    async (request) => {
      const { name, metadata } = request.body;
      const serialized = serializeMetadata(metadata);
      // Inside the slot for the same reason as updatePolicy: a concurrent
      // destroy must not delete the row between check and write.
      const row = await locks.run(name, async () => {
        const existing = findByName(db, name);
        if (!existing) {
          // Not a creator: an unknown key is a typo, same manners as rebuild.
          throw httpError(404, `no sandbox named "${name}" — acquire it first`);
        }
        if ((existing.metadata ?? null) === serialized) {
          // The goal state already holds; a no-op writes no history.
          return existing;
        }
        const updated = updateMetadata(db, existing.id, serialized);
        recordActivity(db, {
          kind: 'metadata-changed',
          sandboxName: name,
          sandboxId: updated.id,
          actor: request.actor,
          detail:
            Object.entries(metadata)
              .map(([key, value]) => `${key}=${value}`)
              .join(', ') || 'cleared',
        });
        return updated;
      });
      return { sandbox: toSandbox(row, endpoint) };
    },
  );

  app.post(
    '/destroySandbox',
    {
      schema: {
        body: destroySandboxRequestSchema,
        response: { 200: destroySandboxResponseSchema },
      },
    },
    async (request) => {
      const { name } = request.body;
      // Same slot as acquire and the scanner: two parallel destroys of one
      // key queue up — the first destroys, the second re-checks and reports
      // the goal state honestly instead of tripping over a half-destroyed
      // sandbox.
      return locks.run(name, async () => {
        const existing = findByName(db, name);
        if (!existing) {
          // Idempotent like acquire: the desired end state — no sandbox
          // under this key — already holds.
          return { destroyed: false };
        }
        if (existing.state === 'restoring') {
          // The one documented dent in destroy's idempotence: tearing the
          // half-built disk down would race the restore task over it. The
          // task finishes in seconds to minutes; retry then.
          throw httpError(409, 'sandbox is restoring; retry when it finishes');
        }
        await destroySandbox(
          db,
          executor,
          existing.id,
          archiver?.store ?? null,
          {
            kind: 'destroyed',
            cause: 'via destroySandbox',
            actor: request.actor,
          },
          watchers,
        );
        return { destroyed: true };
      });
    },
  );
};
