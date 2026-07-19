import {
  updateSettingsRequestSchema,
  updateSettingsResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { recordActivity } from '../db/activity';
import type { Db } from '../db/db';
import { writeRuntimeSettings } from '../db/settings';

export interface SettingsRoutesOptions {
  db: Db;
  /** buildApp's one adjudication of "is the archiver configured". */
  archiveEnabled: boolean;
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
> = async (app, { db, archiveEnabled }) => {
  app.post(
    '/updateSettings',
    {
      schema: {
        body: updateSettingsRequestSchema,
        response: {
          200: updateSettingsResponseSchema,
          400: z.object({ message: z.string() }),
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
        ].join(', '),
      });
      return { settings };
    },
  );
};
