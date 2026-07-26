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
import type { SwapControl } from '../swap';

export interface SettingsRoutesOptions {
  db: Db;
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
 * A pure ledger write with immediate effect: the consumers read live
 * (acquire's capacity gate, the executor's births, resolvePolicy's
 * defaults, the archiver's store, the sandbox proxy's domain), so nothing
 * here restarts, wakes or touches any sandbox. Lowering maxSandboxes below
 * the current total is deliberately legal — the gate only blocks creation,
 * and refusing would leave an operator unable to say "no more" during an
 * incident.
 */
export const settingsRoutes: FastifyPluginAsyncZod<
  SettingsRoutesOptions
> = async (app, { db, swap, probeS3 = defaultProbeS3 }) => {
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
      return { settings };
    },
  );
};
