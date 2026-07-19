import {
  updateSettingsRequestSchema,
  updateSettingsResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { recordActivity } from '../db/activity';
import type { Db } from '../db/db';
import { writeRuntimeSettings } from '../db/settings';
import type { SwapControl } from '../swap';

export interface SettingsRoutesOptions {
  db: Db;
  /** buildApp's one adjudication of "is the archiver configured". */
  archiveEnabled: boolean;
  /**
   * The managed-swap surface, present exactly when the daemon can manage
   * swap (Linux host, docker executor — main.ts's adjudication). Absent,
   * a swapGb patch is refused: an unconfigurable knob must refuse, not
   * silently store a target nothing will ever reconcile.
   */
  swap?: SwapControl;
}

/**
 * updateSettings — the write half of the runtime settings (the read rides
 * on getConfig). Registered in the ADMIN scope: env token or console
 * session only, like the apiKey verbs — a leaked automation key must not
 * be able to raise the very limits that contain it.
 *
 * A pure ledger write with immediate effect: the consumers read live
 * (acquire's capacity gate, the executor's births, resolvePolicy's
 * defaults), so nothing here restarts, wakes or touches any sandbox.
 * Lowering maxSandboxes below the current total is deliberately legal —
 * the gate only blocks creation, and refusing would leave an operator
 * unable to say "no more" during an incident.
 */
export const settingsRoutes: FastifyPluginAsyncZod<
  SettingsRoutesOptions
> = async (app, { db, archiveEnabled, swap }) => {
  app.post(
    '/updateSettings',
    {
      schema: {
        body: updateSettingsRequestSchema,
        response: {
          200: updateSettingsResponseSchema,
          400: z.object({ message: z.string() }),
          500: z.object({ message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const patch = request.body;
      // The updatePolicy doctrine: a default that promises archiving on a
      // daemon with no archiver would be a standing lie in every acquire.
      if (
        !archiveEnabled &&
        patch.defaultPolicy !== undefined &&
        patch.defaultPolicy.archiveAfterSeconds !== null
      ) {
        return reply.code(400).send({
          message:
            'invalid default policy: archiving requires S3 (DORMICE_S3_*) to be configured',
        });
      }
      if (patch.swapGb !== undefined && swap === undefined) {
        return reply.code(400).send({
          message:
            'managing swap requires a Linux host with the docker executor',
        });
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
        ].join(', '),
      });
      // Reconcile after the write: growing mounts new blocks now, shrinking
      // defers itself (the planner never touches an active block). A failed
      // grow — ENOSPC, most likely — leaves the target saved on purpose:
      // the boot reconcile and the next edit retry it, and getConfig's
      // swap.activeGb reports the divergence honestly meanwhile.
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
