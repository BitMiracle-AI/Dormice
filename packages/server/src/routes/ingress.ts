import {
  getIngressResponseSchema,
  setIngressRequestSchema,
  setIngressResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { recordActivity } from '../db/activity';
import type { Db } from '../db/db';
import { httpError } from '../http-error';
import { type Ingress, UnmanagedIngressFileError } from '../ingress';

export interface IngressRoutesOptions {
  db: Db;
  /** Present exactly when DORMICE_INGRESS_FILE is set (the archiver precedent). */
  ingress?: Ingress;
}

/**
 * The daemon's front door, over the wire: bind a domain from the console
 * (or SDK) instead of hand-editing a Caddyfile over SSH. Without a managed
 * ingress the read is honest ({ managed: false }) and the write refuses
 * with the reason — never a silent no-op.
 */
export const ingressRoutes: FastifyPluginAsyncZod<
  IngressRoutesOptions
> = async (app, { db, ingress }) => {
  app.post(
    '/getIngress',
    {
      schema: {
        response: { 200: getIngressResponseSchema },
      },
    },
    async () =>
      ingress
        ? ingress.status()
        : { managed: false, domain: null, probe: null },
  );

  app.post(
    '/setIngress',
    {
      schema: {
        body: setIngressRequestSchema,
        response: { 200: setIngressResponseSchema },
      },
    },
    async (request) => {
      if (!ingress) {
        throw httpError(
          400,
          'this daemon manages no reverse proxy — set DORMICE_INGRESS_FILE (install.sh sets up Caddy and points it at /etc/caddy/Caddyfile), or configure your proxy directly',
        );
      }
      const { domain } = request.body;
      try {
        await ingress.setDomain(domain);
      } catch (error) {
        if (error instanceof UnmanagedIngressFileError) {
          throw httpError(409, error.message);
        }
        throw httpError(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
      recordActivity(db, {
        kind: 'ingress-updated',
        detail: domain
          ? `console domain bound: ${domain} — certificate issuance is Caddy's job from here`
          : 'console domain cleared — plain-HTTP IP access only',
      });
      return { domain };
    },
  );
};
