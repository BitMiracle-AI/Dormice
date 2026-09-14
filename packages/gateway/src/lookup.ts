import {
  type LookupSandboxRequest,
  lookupSandboxResponseSchema,
  type SandboxState,
} from '@dormice/shared';

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

/**
 * The transport's word for a failure, for a log line or a 503's sentence:
 * a system code where there is one (ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT),
 * else the message. Only string codes count — a DOMException carries a
 * numeric legacy `code` (TimeoutError is 23), and "node b did not answer
 * (23)" tells an operator nothing (found by review, 2026-09-14).
 */
export function causeOf(error: unknown): string {
  const e = error as { code?: unknown; message?: string; cause?: unknown };
  const cause = e.cause as { code?: unknown; message?: string } | undefined;
  if (typeof cause?.code === 'string') return cause.code;
  if (cause?.message !== undefined) return cause.message;
  if (typeof e.code === 'string') return e.code;
  return e.message ?? String(error);
}

/**
 * The production asker: HTTP to the node's endpoint under the fleet's
 * token. `fetch`, not undici's `request`, for the deadline: `request`
 * ignores an abort signal while the socket is still connecting, so a node
 * whose host drops the SYN (a VM deleted, a security group closed — the
 * machine-gone case removeNode exists for) held every question for
 * undici's 10s connect timeout, not two seconds — and the creator's
 * confirmation runs inside the name's slot, so twenty queued acquires of a
 * name cached there would have waited 3.5 minutes for the last (measured
 * 2026-09-14: request 10 500ms, fetch 2 001ms, against 192.0.2.1). No
 * redirect is followed: a front that redirects is not a node, and fetch
 * would drop the Authorization header across origins on the way. One
 * quirk comes with fetch: it refuses the Fetch standard's "bad ports"
 * (9, 22, 25, 6000 …) without dialling — no node's front lives on one.
 */
export function httpAskNode(token: string): AskNode {
  return async (node, query) => {
    try {
      const res = await fetch(`${node.endpoint}/lookupSandbox`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        redirect: 'manual',
      });
      if (res.status !== 200) {
        const text = await res.text();
        return {
          kind: 'silent',
          why: `lookupSandbox answered ${res.status}: ${text.slice(0, 200)}`,
        };
      }
      const answer = lookupSandboxResponseSchema.parse(await res.json());
      return answer.found
        ? { kind: 'found', ...answer.sandbox }
        : { kind: 'absent' };
    } catch (error) {
      return { kind: 'silent', why: causeOf(error) };
    }
  };
}
