import {
  type LookupSandboxRequest,
  lookupSandboxResponseSchema,
  type SandboxState,
} from '@dormice/shared';
import { request } from 'undici';

/**
 * Asking one node "do you hold this sandbox?" — the daemon's lookupSandbox
 * verb, the one question the gateway puts to a node on its own account
 * (everything else it sends is a caller's request, forwarded raw). Two
 * seconds, not more: a node that cannot answer a ledger read in two
 * seconds is a node in trouble, and the caller is waiting on the whole
 * round. There is no second, slower deadline — slow is down (design
 * record #35).
 */
export const LOOKUP_TIMEOUT_MS = 2_000;

export type LookupQuery = LookupSandboxRequest;

export type LookupAnswer =
  | { kind: 'found'; id: string; name: string; state: SandboxState }
  | { kind: 'absent' }
  /** The node did not answer: no connection, a timeout, a non-200, an unreadable body. `why` is the transport's word. */
  | { kind: 'silent'; why: string };

export interface AskedNode {
  id: string;
  endpoint: string;
}

export type AskNode = (
  node: AskedNode,
  query: LookupQuery,
) => Promise<LookupAnswer>;

export function causeOf(error: unknown): string {
  const e = error as { code?: string; message?: string; cause?: unknown };
  const cause = e.cause as { code?: string; message?: string } | undefined;
  return cause?.code ?? cause?.message ?? e.code ?? e.message ?? String(error);
}

/** The production asker: HTTP to the node's endpoint under the fleet's token. */
export function httpAskNode(token: string): AskNode {
  return async (node, query) => {
    try {
      const res = await request(`${node.endpoint}/lookupSandbox`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (res.statusCode !== 200) {
        const text = await res.body.text();
        return {
          kind: 'silent',
          why: `lookupSandbox answered ${res.statusCode}: ${text.slice(0, 200)}`,
        };
      }
      const answer = lookupSandboxResponseSchema.parse(await res.body.json());
      return answer.found
        ? { kind: 'found', ...answer.sandbox }
        : { kind: 'absent' };
    } catch (error) {
      return { kind: 'silent', why: causeOf(error) };
    }
  };
}
