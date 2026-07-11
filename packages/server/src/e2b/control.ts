import { randomUUID } from 'node:crypto';
import type { FastifyError } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  countSandboxes,
  createSandbox,
  findBySandboxId,
  findByUserKey,
  listSandboxes,
  setDeadline,
  setPausedByUser,
  touch,
} from '../db/ledger';
import type { SandboxRow } from '../db/schema';
import { findTemplate, resolveImage } from '../db/templates';
import {
  freezeSandbox,
  releaseSandbox,
  stopSandbox,
  wakeSandbox,
} from '../lifecycle';
import { resolvePolicy } from '../policy';
import type { E2bDeps } from './deps';
import {
  apiError,
  E2bError,
  ENVD_VERSION,
  mintEnvdToken,
  verifyApiKey,
} from './protocol';
import { e2bView } from './view';

/**
 * The E2B control plane: what the official SDK calls api.e2b.app for.
 * Mounted under /e2b/api; the SDK reaches it through its `apiUrl` option.
 * Faithful by default — timeouts kill, kill destroys; Dormice's immortality
 * is opt-in via metadata.userKey (idempotent create) or autoPause.
 */

/** The Dormice extension key: metadata.userKey makes create idempotent. */
const USER_KEY_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

/** Seconds; E2B's default sandbox TTL. */
const DEFAULT_TIMEOUT_SECONDS = 300;

const timeoutSchema = z
  .number()
  .int()
  .positive()
  .max(30 * 24 * 60 * 60);

// .loose(): the v2 SDK sends fields we deliberately ignore (secure,
// autoResume, network, ...) — tolerating them is what "two URLs and it
// works" requires; acting on them is tracked feature by feature.
const createBodySchema = z
  .object({
    templateID: z.string().optional(),
    timeout: timeoutSchema.optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    envVars: z.record(z.string(), z.string()).optional(),
    autoPause: z.boolean().optional(),
  })
  .loose();

const timeoutBodySchema = z.object({ timeout: timeoutSchema }).loose();

const connectBodySchema = z
  .object({ timeout: timeoutSchema.optional() })
  .loose();

const pauseBodySchema = z
  .object({ memory: z.boolean().optional() })
  .loose()
  .optional();

const listQuerySchema = z.object({
  metadata: z.string().optional(),
  state: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(100),
  nextToken: z.string().optional(),
});

const notFound = (sandboxId: string) =>
  apiError(404, `sandbox "${sandboxId}" not found`);

export const e2bControlRoutes: FastifyPluginAsyncZod<E2bDeps> = async (
  app,
  { config, db, executor, locks, archiver, archiveDefaultSeconds },
) => {
  /**
   * The archive detour, taken before any slot work: E2B has no restoring
   * concept, so this surface blocks until the sandbox is back — resuming
   * an archived sandbox just takes longer. No-op for anything that is not
   * archived/restoring; joined OUTSIDE the key slot (the restore task's
   * own finish needs it).
   */
  async function joinRestore(row: SandboxRow | undefined): Promise<void> {
    if (!row || (row.state !== 'archived' && row.state !== 'restoring')) {
      return;
    }
    if (!archiver) {
      throw apiError(
        502,
        `sandbox "${row.sandboxId}" is archived but the daemon has no S3 configured (DORMICE_S3_*)`,
      );
    }
    try {
      await archiver.restoreJoin(row.sandboxId);
    } catch (error) {
      throw apiError(
        502,
        `restoring sandbox "${row.sandboxId}" failed: ${error instanceof Error ? error.message : String(error)} — retry`,
      );
    }
  }
  app.addHook('onRequest', async (request, reply) => {
    const presented = request.headers['x-api-key'];
    const key = Array.isArray(presented) ? presented[0] : presented;
    if (!verifyApiKey(config.DORMICE_API_TOKEN, key)) {
      await reply.code(401).send({ code: 401, message: 'invalid API key' });
    }
  });

  // The E2B error dialect: every non-2xx body is { code, message } — the
  // SDK's handleApiError reads both. Scoped here; the native { message }
  // dialect stays untouched outside /e2b.
  app.setErrorHandler((error: FastifyError | E2bError, request, reply) => {
    if (error instanceof E2bError) {
      return reply
        .code(error.statusCode)
        .send({ code: error.code, message: error.message });
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error, 'e2b control request failed');
    }
    // openapi shape: the body's code mirrors the numeric status.
    return reply.code(status).send({ code: status, message: error.message });
  });
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      code: 404,
      message: `route ${request.method} ${request.url} not found`,
    });
  });

  // getHost()'s raw material: the SDK builds <port>-<sandboxId>.<domain>
  // from this field. Present only when the operator configured the wildcard
  // domain — an unconfigured feature is honestly absent, never guessed at.
  const domainField = config.DORMICE_SANDBOX_DOMAIN
    ? { domain: config.DORMICE_SANDBOX_DOMAIN }
    : {};

  // What the views report as the sandbox's template. E2B's alias is the
  // template's human name — present only when a registered template was
  // used; a base sandbox echoes the base image name (or 'base') as its
  // templateID, the honest pre-templates behavior kept for round-trips.
  function templateFields(row: SandboxRow) {
    return {
      templateID: row.template ?? config.DORMICE_BASE_IMAGE ?? 'base',
      ...(row.template ? { alias: row.template } : {}),
    };
  }

  /** What create and connect answer with. */
  function sessionView(row: SandboxRow) {
    return {
      sandboxID: row.sandboxId,
      // The node identity. The JS SDK never reads this field, but the
      // Python SDK's generated models hard-require it on every sandbox
      // response — its absence is a KeyError before user code runs
      // (measured 2026-07-10: the whole Python suite died on create).
      clientID: row.nodeId,
      ...templateFields(row),
      envdVersion: ENVD_VERSION,
      envdAccessToken: mintEnvdToken(config.DORMICE_API_TOKEN, row.sandboxId),
      ...domainField,
    };
  }

  /** What getInfo and list answer with. */
  function infoView(row: SandboxRow, state: 'running' | 'paused') {
    return {
      sandboxID: row.sandboxId,
      // Required by the Python SDK's models, like clientID above.
      clientID: row.nodeId,
      ...templateFields(row),
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      state,
      startedAt: row.createdAt,
      // No deadline (a natively-acquired immortal sandbox) reports a year
      // out, so SDK-side "expired?" arithmetic never trips.
      endAt:
        row.deadlineAt ??
        new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      cpuCount: config.DORMICE_SANDBOX_CPUS,
      memoryMB: Math.round(config.DORMICE_SANDBOX_MEMORY_GB * 1024),
      diskSizeMB: Math.round(config.DORMICE_SANDBOX_DISK_GB * 1024),
      envdVersion: ENVD_VERSION,
      ...domainField,
    };
  }

  /**
   * Looks a sandbox up as the protocol sees it. A row whose kill-deadline
   * has passed is protocol-dead — 404, exactly what the SDK expects of a
   * timed-out sandbox — even while the scanner's physical teardown is still
   * a sweep away.
   */
  function findLive(sandboxId: string): {
    row: SandboxRow;
    state: 'running' | 'paused';
  } {
    const row = findBySandboxId(db, sandboxId);
    if (!row) throw notFound(sandboxId);
    const state = e2bView(row, new Date());
    if (state === 'dead') throw notFound(sandboxId);
    return { row, state };
  }

  /**
   * connect's TTL rule: only ever extended, never shortened. And only for
   * sandboxes the E2B surface created (they always carry onDeadline):
   * a natively-acquired sandbox is immortal by its owner's choice, and the
   * compat surface must not quietly impose a deadline on it.
   */
  function extendDeadline(row: SandboxRow, timeoutSeconds: number): void {
    if (row.onDeadline === null) return;
    const candidate = Date.now() + timeoutSeconds * 1000;
    const current = row.deadlineAt ? Date.parse(row.deadlineAt) : 0;
    if (candidate > current) {
      setDeadline(db, row.sandboxId, {
        deadlineAt: new Date(candidate).toISOString(),
        onDeadline: row.onDeadline,
      });
    }
  }

  app.post(
    '/sandboxes',
    { schema: { body: createBodySchema } },
    async (request, reply) => {
      const body = request.body;
      const timeoutSeconds = body.timeout ?? DEFAULT_TIMEOUT_SECONDS;
      const requestedKey = body.metadata?.userKey;
      if (requestedKey !== undefined && !USER_KEY_PATTERN.test(requestedKey)) {
        throw apiError(
          400,
          `invalid metadata.userKey "${requestedKey}": expected 1-64 chars of [a-zA-Z0-9._-]`,
        );
      }
      const userKey = requestedKey ?? `e2b-${randomUUID()}`;

      // The userKey reuse path may find an archived sandbox; the join
      // brings it back before the slot work below wakes it as usual.
      if (requestedKey !== undefined) {
        await joinRestore(findByUserKey(db, requestedKey));
      }

      // templateID resolution: a registered name wins; 'base', the base
      // image's own name (we have always echoed it as templateID, so it must
      // round-trip) and absence mean the base image; anything else is 404 —
      // the SDK default is the literal string 'base', so `Sandbox.create()`
      // with no template lands on the base image by name, not by fallback.
      let template: string | null = null;
      if (body.templateID !== undefined) {
        if (findTemplate(db, body.templateID)) {
          template = body.templateID;
        } else if (
          body.templateID !== 'base' &&
          body.templateID !== config.DORMICE_BASE_IMAGE
        ) {
          throw apiError(404, `template '${body.templateID}' not found`);
        }
      }

      const row = await locks.run(userKey, async () => {
        const existing = findByUserKey(db, userKey);
        if (existing && e2bView(existing, new Date()) !== 'dead') {
          // The Dormice extension: same key, same sandbox — an acquire in
          // E2B clothes. Stored metadata/envs stay (same principle as the
          // native policy's "override applies at creation only"); the
          // deadline is extended like a connect.
          const awake = await wakeSandbox(db, executor, existing);
          extendDeadline(awake, timeoutSeconds);
          return touch(db, awake.sandboxId);
        }
        if (existing) {
          // Protocol-dead but not yet reaped: E2B semantics say it is gone,
          // so finish the job and build fresh under the same key.
          await releaseSandbox(
            db,
            executor,
            existing.sandboxId,
            archiver?.store ?? null,
            {
              kind: 'released',
              cause: 'protocol-dead row reaped by E2B create',
            },
          );
        }

        if (countSandboxes(db) >= config.DORMICE_MAX_SANDBOXES) {
          throw apiError(
            429,
            `sandbox limit reached (DORMICE_MAX_SANDBOXES=${config.DORMICE_MAX_SANDBOXES}) — release a sandbox or raise the limit`,
          );
        }
        const sandboxId = randomUUID();
        await executor.create(sandboxId, {
          image: resolveImage(db, template),
        });
        return createSandbox(db, {
          sandboxId,
          userKey,
          nodeId: config.DORMICE_NODE_ID,
          policy: resolvePolicy(undefined, archiveDefaultSeconds),
          template,
          e2b: {
            metadata: body.metadata ? JSON.stringify(body.metadata) : null,
            envs:
              body.envVars && Object.keys(body.envVars).length > 0
                ? JSON.stringify(body.envVars)
                : null,
            deadlineAt: new Date(
              Date.now() + timeoutSeconds * 1000,
            ).toISOString(),
            // Faithful default: E2B kills at the deadline unless the caller
            // opted into pause (lifecycle.onTimeout='pause' on the wire).
            onDeadline: body.autoPause ? 'pause' : 'kill',
          },
        });
      });
      return reply.code(201).send(sessionView(row));
    },
  );

  app.post(
    '/sandboxes/:id/connect',
    { schema: { body: connectBodySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const before = findLive(id);
      // An archived sandbox resumes through the archiver first — connect
      // then finds it active and the wake below is a no-op. Blocking is the
      // faithful behavior: E2B's connect returns a live sandbox, period.
      await joinRestore(before.row);
      const row = await locks.run(before.row.userKey, async () => {
        const fresh = findBySandboxId(db, id);
        if (!fresh || e2bView(fresh, new Date()) === 'dead') {
          throw notFound(id);
        }
        const awake = await wakeSandbox(db, executor, fresh);
        extendDeadline(awake, request.body.timeout ?? DEFAULT_TIMEOUT_SECONDS);
        return touch(db, awake.sandboxId);
      });
      // 200 = it was already running, 201 = this connect resumed it.
      return reply
        .code(before.state === 'running' ? 200 : 201)
        .send(sessionView(row));
    },
  );

  app.get('/sandboxes/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { row, state } = findLive(id);
    return infoView(row, state);
  });

  // The SDK sends start/end (unix seconds) to slice a metrics history; we
  // keep none — the daemon is an observation window, not a monitoring
  // system — so the answer is always one sample, taken now. loose() admits
  // the query without acting on it.
  app.get(
    '/sandboxes/:id/metrics',
    { schema: { querystring: z.object({}).loose() } },
    async (request) => {
      const { id } = request.params as { id: string };
      const { row } = findLive(id);
      // Physical stopped/archived: nothing is running to measure, and
      // measuring must never wake a sandbox (observation is not activity —
      // the same principle that keeps list from waking). [] is the honest
      // answer, and a legal one to the SDK.
      if (row.state !== 'active' && row.state !== 'frozen') return [];
      const m = await executor.metrics(row.sandboxId);
      const now = new Date();
      return [
        {
          timestamp: now.toISOString(),
          timestampUnix: Math.floor(now.getTime() / 1000),
          cpuCount: m.cpuCount,
          cpuUsedPct: m.cpuUsedPct,
          memUsed: m.memUsedBytes,
          memTotal: m.memTotalBytes,
          memCache: m.memCacheBytes,
          diskUsed: m.diskUsedBytes,
          diskTotal: m.diskTotalBytes,
        },
      ];
    },
  );

  app.delete('/sandboxes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    // kill = release, for real: container, disk and row gone. Persistence
    // on the E2B surface is "don't kill" (autoPause / userKey), never a
    // kill that secretly keeps data.
    const { row } = findLive(id);
    if (row.state === 'restoring') {
      // A mid-restore teardown would race the task over the half-built
      // disk; join it first. The outcome is irrelevant — we are deleting
      // either way, and a failed restore parks the row back on archived,
      // whose release below deletes the S3 object.
      await archiver?.restoreJoin(id).catch(() => {});
    }
    await locks.run(row.userKey, async () => {
      const fresh = findBySandboxId(db, id);
      if (!fresh) throw notFound(id);
      await releaseSandbox(
        db,
        executor,
        fresh.sandboxId,
        archiver?.store ?? null,
        { kind: 'released', cause: 'via E2B kill' },
      );
    });
    return reply.code(204).send();
  });

  app.post(
    '/sandboxes/:id/timeout',
    { schema: { body: timeoutBodySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { row } = findLive(id);
      // setTimeout overwrites in both directions, measured from now — but
      // only for E2B-created sandboxes; native ones stay immortal.
      if (row.onDeadline !== null) {
        setDeadline(db, row.sandboxId, {
          deadlineAt: new Date(
            Date.now() + request.body.timeout * 1000,
          ).toISOString(),
          onDeadline: row.onDeadline,
        });
      }
      return reply.code(204).send();
    },
  );

  app.post(
    '/sandboxes/:id/pause',
    { schema: { body: pauseBodySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const before = findLive(id);
      if (before.state === 'paused') {
        // The SDK reads a 409 as "already paused" and answers false.
        throw apiError(409, 'sandbox is already paused');
      }
      await locks.run(before.row.userKey, async () => {
        const fresh = findBySandboxId(db, id);
        if (!fresh) throw notFound(id);
        let current = fresh;
        if (current.state === 'active') {
          current = await freezeSandbox(
            db,
            executor,
            current.sandboxId,
            'paused via E2B',
          );
        }
        // keepMemory:false maps to stopped: filesystem only, cold boot on
        // resume — physically exactly what E2B promises for it.
        if (request.body?.memory === false && current.state === 'frozen') {
          await stopSandbox(
            db,
            executor,
            current.sandboxId,
            'paused via E2B (memory discarded)',
          );
        }
        setPausedByUser(db, fresh.sandboxId, true);
      });
      return reply.code(204).send();
    },
  );

  app.get(
    '/v2/sandboxes',
    { schema: { querystring: listQuerySchema } },
    async (request, reply) => {
      const { metadata, state, limit, nextToken } = request.query;
      const wanted = new Set(
        (state ? state.split(',') : ['running', 'paused']).map((s) => s.trim()),
      );
      const filters = [...new URLSearchParams(metadata ?? '')];

      const now = new Date();
      const all = listSandboxes(db)
        .map((row) => ({ row, state: e2bView(row, now) }))
        .filter(
          (item): item is { row: SandboxRow; state: 'running' | 'paused' } => {
            if (item.state === 'dead' || !wanted.has(item.state)) return false;
            if (filters.length === 0) return true;
            const meta: Record<string, string> = item.row.metadata
              ? JSON.parse(item.row.metadata)
              : {};
            return filters.every(([key, value]) => meta[key] === value);
          },
        )
        // Newest first, like the E2B dashboard; stable under pagination.
        .sort((a, b) => (a.row.createdAt < b.row.createdAt ? 1 : -1));

      const offset = Number(nextToken ?? '0') || 0;
      const page = all.slice(offset, offset + limit);
      if (offset + limit < all.length) {
        // The v2 pagination protocol: the cursor lives in this header; its
        // absence is what means "no next page".
        reply.header('x-next-token', String(offset + limit));
      }
      return page.map((item) => infoView(item.row, item.state));
    },
  );
};
