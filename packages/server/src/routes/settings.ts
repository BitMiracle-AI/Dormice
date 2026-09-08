import {
  updateSettingsRequestSchema,
  updateSettingsResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { probeS3 as defaultProbeS3, S3ProbeError } from '../archive/probe';
import type { S3Settings } from '../archive/s3-store';
import { recordActivity } from '../db/activity';
import type { Db } from '../db/db';
import { countByState, listSandboxes } from '../db/ledger';
import {
  archiveEnabled,
  readRuntimeSettings,
  writeRuntimeSettings,
} from '../db/settings';
import type { Executor } from '../executor/executor';
import type { KeyedQueue } from '../keyed-queue';
import { sweepPidsLimit } from '../pids-sweep';
import type { SwapControl } from '../swap';

export interface SettingsRoutesOptions {
  db: Db;
  /**
   * For the pids cap's sweep over running shells after a write — the one
   * settings knob with a reality on every running sandbox. Same executor
   * and per-sandbox queue as the rest of the daemon.
   */
  executor: Executor;
  locks: KeyedQueue;
  /**
   * The managed-swap surface, present exactly when the daemon can manage
   * swap (Linux host, docker executor — main.ts's adjudication). Absent,
   * a swapGb patch is refused: an unconfigurable knob must refuse, not
   * silently store a target nothing will ever reconcile.
   */
  swap?: SwapControl;
  /** Test seam over the S3 round-trip probe; production uses the real one. */
  probeS3?: (s3: S3Settings) => Promise<void>;
}

/**
 * updateSettings — the write half of the runtime settings (the read rides
 * on getConfig). Registered in the ADMIN scope: env token or console
 * session only, like the apiKey verbs — a leaked automation key must not
 * be able to raise the very limits that contain it.
 *
 * A ledger write with immediate effect: the consumers read live
 * (acquire's capacity gate, the executor's births, resolvePolicy's
 * defaults, the archiver's store, the sandbox proxy's domain, the
 * executor's pids cap at each birth and wake), so nothing here restarts or
 * wakes a sandbox. Two knobs have a reality on the host that the write
 * alone does not move, and each is reconciled right after it: managed swap
 * (a swapfile) and the pids cap on the shells running right now (a cgroup
 * write their processes never notice). Lowering maxSandboxes below the
 * current total is deliberately legal — the gate only blocks creation, and
 * refusing would leave an operator unable to say "no more" during an
 * incident.
 */
export const settingsRoutes: FastifyPluginAsyncZod<
  SettingsRoutesOptions
> = async (app, { db, executor, locks, swap, probeS3 = defaultProbeS3 }) => {
  app.post(
    '/updateSettings',
    {
      schema: {
        body: updateSettingsRequestSchema,
        response: {
          200: updateSettingsResponseSchema,
          400: z.object({ message: z.string() }),
          500: z.object({ message: z.string() }),
          502: z.object({ message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const patch = request.body;
      // The updatePolicy doctrine, judged against the post-patch state (an
      // s3 group and an archiving default may arrive in one patch): a
      // default that promises archiving on a daemon with no store would be
      // a standing lie in every acquire.
      const s3After =
        patch.s3 !== undefined ? patch.s3 !== null : archiveEnabled(db);
      if (
        !s3After &&
        patch.defaultPolicy !== undefined &&
        patch.defaultPolicy.archiveAfterSeconds !== null
      ) {
        return reply.code(400).send({
          message:
            'invalid default policy: archiving requires an S3 archive store — configure one in the console settings first',
        });
      }
      if (patch.swapGb !== undefined && swap === undefined) {
        return reply.code(400).send({
          message:
            'managing swap requires a Linux host with the docker executor',
        });
      }
      // The alias-list guard, judged against the post-patch state — domain
      // and aliases may arrive in one patch, which is exactly how the
      // console swaps the canonical domain atomically. Violations are
      // refused, never silently rewritten (the echoed settings must be
      // what was written). Before the s3 block on purpose: pure in-memory
      // checks don't queue behind a network probe.
      if (
        patch.sandboxDomain !== undefined ||
        patch.sandboxDomainAliases !== undefined
      ) {
        const current = readRuntimeSettings(db);
        const domainAfter =
          patch.sandboxDomain !== undefined
            ? patch.sandboxDomain
            : current.sandboxDomain;
        const aliasesAfter =
          patch.sandboxDomainAliases ?? current.sandboxDomainAliases;
        const lower = aliasesAfter.map((alias) => alias.toLowerCase());
        const dup = aliasesAfter.find(
          (alias, i) => lower.indexOf(alias.toLowerCase()) !== i,
        );
        if (dup !== undefined) {
          return reply.code(400).send({
            message: `sandboxDomainAliases lists ${dup} more than once — hostnames are case-insensitive, send each alias exactly once`,
          });
        }
        if (domainAfter !== null && lower.includes(domainAfter.toLowerCase())) {
          return reply.code(400).send({
            message: `${domainAfter} is already the sandbox domain — sandboxDomainAliases only takes the extra hostnames`,
          });
        }
        if (domainAfter === null && aliasesAfter.length > 0) {
          return reply.code(400).send({
            message:
              patch.sandboxDomain === null
                ? `clearing sandboxDomain would leave ${aliasesAfter.length} alias${aliasesAfter.length === 1 ? '' : 'es'} pointing at nothing — clear sandboxDomainAliases (send []) in the same request`
                : 'sandboxDomainAliases needs a sandbox domain in force — set sandboxDomain first',
          });
        }
      }
      if (patch.s3 !== undefined) {
        // The moving-store guard: archived disks live in the current
        // endpoint+bucket, and pointing elsewhere (or clearing) would
        // strand them. Enabling from off is always allowed — when drift
        // left archived rows behind with no store, pointing back at the
        // original bucket is the one repair path. Credential/region/
        // path-style changes move nothing and pass freely.
        const current = readRuntimeSettings(db).s3;
        const moving =
          patch.s3 === null ||
          (current !== null &&
            (patch.s3.endpoint !== current.endpoint ||
              patch.s3.bucket !== current.bucket));
        if (current !== null && moving) {
          const { byState } = countByState(listSandboxes(db));
          const held = byState.archived + byState.restoring;
          if (held > 0) {
            return reply.code(400).send({
              message: `${held} sandbox${held === 1 ? ' is' : 'es are'} archived or restoring in the current store — restore or destroy them before ${
                patch.s3 === null
                  ? 'clearing the archive store'
                  : 'moving it to another endpoint or bucket'
              }`,
            });
          }
        }
        if (patch.s3 !== null) {
          // Probe BEFORE the write — a failure leaves the ledger untouched
          // (see archive/probe.ts for why this is the opposite of swap's
          // save-then-reconcile).
          try {
            await probeS3(patch.s3);
          } catch (error) {
            const probeFailure =
              error instanceof S3ProbeError
                ? error
                : new S3ProbeError(
                    error instanceof Error ? error.message : String(error),
                    undefined,
                  );
            const status =
              probeFailure.httpStatusCode !== undefined &&
              probeFailure.httpStatusCode >= 400 &&
              probeFailure.httpStatusCode < 500
                ? (400 as const)
                : (502 as const);
            return reply.code(status).send({
              message: `the S3 store did not pass a write-read-delete probe, nothing was saved — ${probeFailure.message}`,
            });
          }
        }
      }
      const settings = writeRuntimeSettings(db, patch, new Date());
      recordActivity(db, {
        kind: 'settings-updated',
        actor: request.actor,
        detail: [
          ...(patch.maxSandboxes !== undefined
            ? [`maxSandboxes=${patch.maxSandboxes}`]
            : []),
          ...(patch.sandboxDefaults !== undefined
            ? [
                `sandboxDefaults=${patch.sandboxDefaults.cpus}cpu/${patch.sandboxDefaults.memoryGb}GiB/${patch.sandboxDefaults.diskGb}GiB`,
              ]
            : []),
          ...(patch.defaultPolicy !== undefined
            ? [
                `defaultPolicy=${patch.defaultPolicy.freezeAfterSeconds}s/${patch.defaultPolicy.stopAfterSeconds ?? 'never'}/${patch.defaultPolicy.archiveAfterSeconds ?? 'never'}`,
              ]
            : []),
          ...(patch.swapGb !== undefined ? [`swapGb=${patch.swapGb}`] : []),
          // Endpoint and bucket only — the keys never reach the activity
          // feed, the same "value never crosses" rule as the wire's.
          ...(patch.s3 !== undefined
            ? [
                patch.s3 === null
                  ? 's3=cleared'
                  : `s3=${patch.s3.endpoint}/${patch.s3.bucket}`,
              ]
            : []),
          ...(patch.sandboxDomain !== undefined
            ? [`sandboxDomain=${patch.sandboxDomain ?? 'cleared'}`]
            : []),
          // '/' inside the list — ',' is the fragment separator above.
          ...(patch.sandboxDomainAliases !== undefined
            ? [
                patch.sandboxDomainAliases.length === 0
                  ? 'sandboxDomainAliases=cleared'
                  : `sandboxDomainAliases=${patch.sandboxDomainAliases.join('/')}`,
              ]
            : []),
          ...(patch.pidsLimit !== undefined
            ? [`pidsLimit=${patch.pidsLimit}`]
            : []),
        ].join(', '),
      });
      // Reconcile after the write: growing mounts new blocks now, shrinking
      // defers itself (the planner never touches an active block). A failed
      // grow — ENOSPC, most likely — leaves the target saved on purpose:
      // the boot reconcile and the next edit retry it, and getConfig's
      // swap.activeGb reports the divergence honestly.
      if (patch.swapGb !== undefined && swap !== undefined) {
        try {
          await swap.reconcile(patch.swapGb);
        } catch (error) {
          return reply.code(500).send({
            message: `swap target saved (${patch.swapGb} GiB) but applying it failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      }
      // The write already reached every future birth and wake; the sweep
      // brings the shells running right now along — an operator raising
      // the cap during an incident is looking at exactly those. A shell
      // the runtime refuses keeps its old cap until its next wake, and the
      // answer says so by name; the value stays saved either way.
      if (patch.pidsLimit !== undefined) {
        const sweep = await sweepPidsLimit(db, executor, locks);
        app.log.info(sweep, 'pids cap sweep after updateSettings');
        if (sweep.failures.length > 0) {
          return reply.code(500).send({
            message: `pids cap saved (${patch.pidsLimit}) but ${sweep.failures.length} of ${sweep.considered} active sandboxes kept their old cap until their next wake — ${sweep.failures[0]}`,
          });
        }
      }
      return { settings };
    },
  );
};
