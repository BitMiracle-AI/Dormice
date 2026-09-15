import {
  type LookupSandboxRequest,
  lookupSandboxResponseSchema,
  type SandboxState,
} from '@dormice/shared';
import type { z } from 'zod';

/**
 * Asking one node a question on the gateway's own account — a read-only
 * verb the gateway sends that is not a caller's request forwarded raw:
 * the finder's lookupSandbox ("do you hold this sandbox?"), removeTemplate's
 * templateUsers, the merged lists (merge.ts), the E2B list's page. One
 * transport (httpAsk) under the fleet token; the callers differ in what
 * they ask and how long they wait.
 *
 * The lookup's deadline. Two seconds, not more: a node that cannot answer
 * a ledger read in two seconds is a node in trouble, and the caller is
 * waiting on the whole round. There is no second, slower deadline for a
 * lookup — slow is down (design record #35). A verb that reads containers
 * waits longer (merge.ts MERGE_TIMEOUT_MS).
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

/** A node's answer to any verb asked on the gateway's account: parsed (with the answer's headers, for the one verb that pages by one), or silence with the transport's word. */
export type Asked<T> =
  | { kind: 'answer'; value: T; headers: Headers }
  | { kind: 'silent'; why: string };

/** How a verb is asked, where the native default does not fit. */
export interface AskOptions {
  /** GET for the E2B control plane's list; POST, the native dialect, by default. */
  method?: 'GET' | 'POST';
  /** The fleet token as the native Bearer (default) or as E2B's x-api-key. */
  credential?: 'bearer' | 'x-api-key';
  /** LOOKUP_TIMEOUT_MS by default — a ledger read; longer for a verb that reads containers (merge.ts). */
  timeoutMs?: number;
}

/** Asks one node one verb, validated by the schema of its answer. `verb` is the path under the node's endpoint, query string included for a GET. */
export type AskVerb = <T>(
  node: AskedNode,
  verb: string,
  body: unknown,
  schema: z.ZodType<T>,
  options?: AskOptions,
) => Promise<Asked<T>>;

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
export function httpAsk(token: string): AskVerb {
  return async (node, verb, body, schema, options = {}) => {
    const method = options.method ?? 'POST';
    try {
      const res = await fetch(`${node.endpoint}/${verb}`, {
        method,
        headers: {
          ...(options.credential === 'x-api-key'
            ? { 'x-api-key': `e2b_${token}` }
            : { authorization: `Bearer ${token}` }),
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs ?? LOOKUP_TIMEOUT_MS),
        redirect: 'manual',
      });
      if (res.status !== 200) {
        const text = await res.text();
        return {
          kind: 'silent',
          why: `${verb} answered ${res.status}: ${text.slice(0, 200)}`,
        };
      }
      // A body the schema refuses is a node the gateway cannot read —
      // a build too far apart, or not a node at all — and is silence
      // that says so, not a 500 out of the gateway's own serializer.
      const parsed = schema.safeParse(await res.json());
      if (!parsed.success) {
        return {
          kind: 'silent',
          why: `${verb} answered a body the gateway cannot read (${parsed.error.issues[0]?.message ?? 'schema mismatch'})`,
        };
      }
      return { kind: 'answer', value: parsed.data, headers: res.headers };
    } catch (error) {
      return { kind: 'silent', why: causeOf(error) };
    }
  };
}

/** lookupSandbox over httpAsk, in the words find.ts reads. */
export function httpAskNode(token: string): AskNode {
  const ask = httpAsk(token);
  return async (node, query) => {
    const asked = await ask(
      node,
      'lookupSandbox',
      query,
      lookupSandboxResponseSchema,
    );
    if (asked.kind === 'silent') return asked;
    return asked.value.found
      ? { kind: 'found', ...asked.value.sandbox }
      : { kind: 'absent' };
  };
}
