import {
  listSandboxesResponseSchema,
  listSandboxImagesResponseSchema,
  listSandboxMetricsResponseSchema,
} from '@dormice/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Fleet } from '../fleet';
import type { AskVerb } from '../lookup';
import { askEach } from '../merge';

export interface ObserveRoutesOptions {
  fleet: Fleet;
  /** Asks one node one verb on the gateway's account (lookup.ts httpAsk). */
  ask: AskVerb;
}

/**
 * The fleet-wide lists: the three observation verbs whose answer is every
 * node's answer put together — listSandboxes, listSandboxMetrics,
 * listSandboxImages. Every askable node is asked in parallel (merge.ts),
 * the arrays are concatenated in node-id order with each node's own
 * order kept (the caller filters and sorts, as the wire has always said),
 * and the nodes the answer lacks are named in `silent` — always present
 * here, empty when nobody was missing. A node's own answer has nobody to
 * be silent about and carries none.
 *
 * Behind the sandbox gate, like the node's: observation is what every
 * credential that addresses a sandbox may do. Nothing here wakes a
 * sandbox; the nodes' verbs never did.
 */
export const observeRoutes: FastifyPluginAsyncZod<
  ObserveRoutesOptions
> = async (app, { fleet, ask }) => {
  app.post(
    '/listSandboxes',
    { schema: { response: { 200: listSandboxesResponseSchema } } },
    async () => {
      const { answers, silent } = await askEach(
        fleet,
        ask,
        new Date(),
        'listSandboxes',
        {},
        listSandboxesResponseSchema,
      );
      return {
        sandboxes: answers.flatMap((a) => a.value.sandboxes),
        silent,
      };
    },
  );

  app.post(
    '/listSandboxMetrics',
    { schema: { response: { 200: listSandboxMetricsResponseSchema } } },
    async () => {
      const { answers, silent } = await askEach(
        fleet,
        ask,
        new Date(),
        'listSandboxMetrics',
        {},
        listSandboxMetricsResponseSchema,
      );
      return { samples: answers.flatMap((a) => a.value.samples), silent };
    },
  );

  app.post(
    '/listSandboxImages',
    { schema: { response: { 200: listSandboxImagesResponseSchema } } },
    async () => {
      const { answers, silent } = await askEach(
        fleet,
        ask,
        new Date(),
        'listSandboxImages',
        {},
        listSandboxImagesResponseSchema,
      );
      return { images: answers.flatMap((a) => a.value.images), silent };
    },
  );
};
