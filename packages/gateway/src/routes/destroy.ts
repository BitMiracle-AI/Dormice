import type http from 'node:http';
import type { FastifyRequest } from 'fastify';
import type { CacheEntry, NameCache } from '../cache';
import type { NodeState } from '../fleet';
import {
  type CapturedResponse,
  type Credential,
  forwardCapture,
} from '../forward';

export interface DestroyOptions {
  target: NodeState;
  token: string;
  /** The cache entry the verb addresses — forgotten on the node's yes. */
  entry: CacheEntry;
  body: Buffer | undefined;
  credential: Credential;
}

/**
 * The one destroy path, the mirror of create.ts: the native destroySandbox
 * and the E2B kill both forward, wait for the node's whole answer and
 * learn from a 2xx — the cache entry goes. Only the node's yes teaches
 * anything: its 404 is not "gone" (the daemon answers 404 for a sandbox
 * past its kill deadline that its scanner has not torn down yet, a row a
 * lookup would still answer yes for), and a 5xx or no answer leaves the
 * cache as it was. The cache is a cache: an entry kept one destroy too
 * long costs the next request one 404 and a re-check (find.ts verify).
 */
export async function forwardDestroy(
  cache: NameCache,
  request: FastifyRequest,
  res: http.ServerResponse,
  { target, token, entry, body, credential }: DestroyOptions,
): Promise<CapturedResponse | null> {
  const answer = await forwardCapture(request.raw, res, {
    target: { endpoint: target.endpoint, token },
    credential,
    body,
  });
  if (answer === null) return null;
  if (answer.status >= 200 && answer.status < 300) cache.evict(entry);
  return answer;
}
