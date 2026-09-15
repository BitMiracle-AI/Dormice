import type { S3Settings } from '@dormice/server/s3-store';
import {
  getConfigResponseSchema,
  updateSettingsRequestSchema,
  updateSettingsResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CONFIG_KEYS, type Config, type ConfigSources } from '../config';
import type { Db } from '../db/db';
import {
  readConfigVersion,
  readS3Settings,
  readSettings,
  writeSettings,
} from '../db/settings';
import type { Fleet } from '../fleet';
import { probeS3 as defaultProbeS3, S3ProbeError } from '../probe';

export interface SettingsRoutesOptions {
  config: Config;
  db: Db;
  fleet: Fleet;
  sources: ConfigSources;
  /** Test seam over the S3 round-trip probe; production uses the real one. */
  probeS3?: (s3: S3Settings) => Promise<void>;
}

/**
 * The fleet's settings, read and written at the one door (design record
 * #22). getConfig answers the gateway's env knobs (read-only; secrets
 * present-or-absent) plus the settings table in force; updateSettings is
 * a table write with a version bump — every node hears of it at its next
 * check-in and applies it there (the pids sweep over running shells, the
 * archiver's store, the proxy's domain are the node's to reconcile, so
 * nothing here restarts or wakes a sandbox). Behind the admin gate: a
 * leaked automation key must not be able to move the limits that contain
 * it.
 *
 * The one guard that needs the fleet: moving or clearing the archive store
 * strands every disk archived in it, and those disks live on the nodes'
 * ledgers. The gateway holds no sandbox state, but every node's last
 * check-in carries its census by state, so the count of archived and
 * restoring sandboxes across the fleet is at hand — for every node that
 * has ever reported (its last reading outlives a gateway restart on its
 * row). One that never has — a row the import pre-created, before the
 * node's first check-in — is a node whose disks cannot be counted, and
 * the write refuses (503, retry after that check-in) rather than guess.
 */
export const settingsRoutes: FastifyPluginAsyncZod<
  SettingsRoutesOptions
> = async (app, { config, db, fleet, sources, probeS3 = defaultProbeS3 }) => {
  app.post(
    '/getConfig',
    {
      schema: {
        response: { 200: getConfigResponseSchema },
      },
    },
    async () => {
      const settings = readSettings(db);
      const enabled = settings.s3 !== null;
      return {
        entries: (Object.keys(CONFIG_KEYS) as Array<keyof Config>).map(
          (key) => {
            const { sensitive } = CONFIG_KEYS[key];
            const value = config[key];
            return {
              key,
              value: sensitive || value === undefined ? null : String(value),
              source: sources[key],
              ...(sensitive && value !== undefined ? { redacted: true } : {}),
            };
          },
        ),
        archive: {
          enabled,
          defaultSeconds: enabled
            ? settings.defaultPolicy.archiveAfterSeconds
            : null,
        },
        settings,
        configVersion: readConfigVersion(db),
      };
    },
  );

  app.post(
    '/updateSettings',
    {
      schema: {
        body: updateSettingsRequestSchema,
        response: {
          200: updateSettingsResponseSchema,
          400: z.object({ message: z.string() }),
          502: z.object({ message: z.string() }),
          503: z.object({ message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const patch = request.body;
      // The updatePolicy doctrine, judged against the post-patch state (an
      // s3 group and an archiving default may arrive in one patch): a
      // default that promises archiving on a fleet with no store would be
      // a standing lie in every acquire.
      const current = readSettings(db);
      const s3After =
        patch.s3 !== undefined ? patch.s3 !== null : current.s3 !== null;
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
        const store = readS3Settings(db);
        const moving =
          patch.s3 === null ||
          (store !== null &&
            (patch.s3.endpoint !== store.endpoint ||
              patch.s3.bucket !== store.bucket));
        if (store !== null && moving) {
          const held = archivedAcrossFleet(fleet);
          if ('unknown' in held) {
            reply.header('retry-after', '15');
            return reply.code(503).send({
              message: `${held.unknown.map((id) => `node ${id}`).join(', ')} ${held.unknown.length === 1 ? 'has' : 'have'} never checked in, so the sandboxes archived in the current store cannot be counted — retry after ${held.unknown.length === 1 ? 'its' : 'their'} first check-in, or remove ${held.unknown.length === 1 ? 'it' : 'them'} if gone for good`,
            });
          }
          if (held.count > 0) {
            return reply.code(400).send({
              message: `${held.count} sandbox${held.count === 1 ? ' is' : 'es are'} archived or restoring in the current store across the fleet — restore or destroy them before ${
                patch.s3 === null
                  ? 'clearing the archive store'
                  : 'moving it to another endpoint or bucket'
              }`,
            });
          }
        }
        if (patch.s3 !== null) {
          // Probe BEFORE the write — a failure leaves the table untouched
          // (probe.ts has why).
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
      const settings = writeSettings(db, patch, new Date());
      request.log.info(
        { settings },
        `fleet settings updated: ${[
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
          // Endpoint and bucket only — the keys never reach the log, the
          // same "value never crosses" rule as the wire's.
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
        ].join(', ')}; the nodes apply it at their next check-in`,
      );
      return { settings };
    },
  );
};

/**
 * How many sandboxes across the fleet are archived or restoring, by the
 * nodes' last readings — or the ids of the nodes whose count is unknown
 * because they have not checked in since this gateway started. A node
 * that is merely late is still counted by its last reading: a sandbox
 * archives over minutes, not the seconds a check-in can be late by, and
 * the guard errs toward refusing anyway (a non-zero count refuses).
 */
function archivedAcrossFleet(
  fleet: Fleet,
): { count: number } | { unknown: string[] } {
  const unknown: string[] = [];
  let count = 0;
  for (const node of fleet.all()) {
    if (node.reading === null) {
      unknown.push(node.id);
      continue;
    }
    count +=
      node.reading.sandboxes.byState.archived +
      node.reading.sandboxes.byState.restoring;
  }
  return unknown.length > 0 ? { unknown: unknown.sort() } : { count };
}
