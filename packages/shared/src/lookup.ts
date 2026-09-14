import { z } from 'zod';
import { sandboxNameSchema } from './sandbox';
import { SANDBOX_STATES } from './states';

/**
 * lookupSandbox({ name }) / lookupSandbox({ id }) / lookupSandbox({ signed })
 * — "do you hold this sandbox?", the one question a gateway asks a node
 * on its own account. The gateway keeps no directory of where sandboxes
 * live (a second copy of a fact the nodes' ledgers already hold, and
 * every copy drifts); when its cache has no answer it asks every node
 * this, in parallel, and routes to the one that says yes. Read-only by
 * construction: it never wakes, never touches the idle clock, never
 * creates.
 *
 * The node answers inside the name's serialization slot when it must: a
 * row that exists answers at once, whatever its state; no row while an
 * acquire of that name is in flight waits for the acquire (the daemon
 * creates first and writes the row second, both under the slot) and looks
 * again — so a gateway retrying a create whose answer was lost never
 * places a second copy: while the build is still running the gateway's
 * two-second patience runs out first and the caller is told to retry
 * (503 with Retry-After); once the row is written, the retry finds the
 * sandbox on the node that built it.
 */

/**
 * The third way of naming a sandbox: by the signature of a bare signed
 * file URL. The SDK's uploadUrl/downloadUrl build `<origin>/files?…
 * signature=…` off the API origin they were given — no sandbox id
 * anywhere in the request, whatever domain is in force — and the
 * signature is readable only by the secret of the node that minted the
 * sandbox's token (server/e2b/signing.ts). So the gateway hands every node
 * the query as it arrived and the door's operation, and the node whose
 * live sandbox signed it says so. Identity only: the expiration and the
 * rest of the signed material are judged by the door the request is then
 * forwarded to, in its own order.
 */
export const signedFileLookupSchema = z.object({
  operation: z.enum(['read', 'write']),
  /** The request's query string as sent, without the leading `?`. */
  query: z.string(),
});

export type SignedFileLookup = z.infer<typeof signedFileLookupSchema>;

export const lookupSandboxRequestSchema = z.union([
  z.object({ name: sandboxNameSchema }),
  z.object({ id: z.string().min(1) }),
  z.object({ signed: signedFileLookupSchema }),
]);

export type LookupSandboxRequest = z.infer<typeof lookupSandboxRequestSchema>;

export const lookupSandboxResponseSchema = z.discriminatedUnion('found', [
  z.object({
    found: z.literal(true),
    sandbox: z.object({
      id: z.string(),
      name: sandboxNameSchema,
      state: z.enum(SANDBOX_STATES),
    }),
  }),
  z.object({ found: z.literal(false) }),
]);

export type LookupSandboxResponse = z.infer<typeof lookupSandboxResponseSchema>;
