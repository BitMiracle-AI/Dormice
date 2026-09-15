import type { SilentNode } from '@dormice/shared';
import type { z } from 'zod';
import type { AskOptions, AskVerb } from './ask';
import {
  awaitingFirstConfig,
  awaitingFirstConfigWhy,
  downReason,
  type Fleet,
  type NodeState,
} from './fleet';

/**
 * How long a merged answer waits for a node. Longer than a lookup's two
 * seconds on purpose: a lookup is one ledger read, while listSandboxMetrics
 * reads every running container (about a second each, in parallel) and
 * listSandboxImages inspects every shell — a busy node legitimately takes
 * several seconds, and "slow is down" (design record #35) was said of
 * finding a sandbox, where the caller holds a name's slot. Past it the
 * node is silent for this answer, and named as such.
 */
export const MERGE_TIMEOUT_MS = 10_000;

/**
 * Whether a node is asked for a merged answer, and if not, what the
 * answer says about it (`why` null: nothing — it holds nothing the answer
 * could lack). Not asked:
 *   - a node that is down (fleet.ts downReason: two of its own intervals
 *     silent, or never checked in). A dial would wait the whole timeout
 *     for nothing, on every console poll, for as long as it stayed down —
 *     it is named with the reason placement refuses it;
 *   - a node awaiting its first configuration (awaitingFirstConfig): not
 *     listening, so a dial is refused at the socket and would read as
 *     silence anyway. Named when its reading says it holds sandboxes.
 * Judged from the row after a gateway restart as from memory before one
 * (fleet.ts): a node that checked in seconds before the restart is asked
 * at once. The third cut, holding the check-in in memory only, asked
 * every node not yet heard from for a thirty-second grace after a start;
 * the rows made the grace unnecessary (fourth cut).
 */
export type Askability = { ask: true } | { ask: false; why: string | null };

export function askability(node: NodeState, now: Date): Askability {
  const down = downReason(node, now);
  if (down !== null) return { ask: false, why: down };
  if (awaitingFirstConfig(node)) {
    return { ask: false, why: awaitingFirstConfigWhy(node) };
  }
  return { ask: true };
}

export interface Merged<T> {
  /** The nodes that answered, in node-id order, with what they said. */
  answers: Array<{ node: NodeState; value: T; headers: Headers }>;
  /** The nodes this answer lacks, in node-id order (shared silentNodeSchema). */
  silent: SilentNode[];
}

/** What every node is asked. */
export interface EachAsk<T> {
  /** The path under each node's endpoint (query string included for a GET) — or a function of the node: the E2B list sends each node its own offset. */
  verb: string | ((node: NodeState) => string);
  /** The POST body; none for a GET. */
  body?: unknown;
  /** The shape of one node's answer; a body that fails it is silence (ask.ts httpAsk). */
  schema: z.ZodType<T>;
  /** How the verb is asked (ask.ts AskOptions); the timeout defaults to MERGE_TIMEOUT_MS. */
  options?: AskOptions;
  /** The instant askability is judged at; now by default, injected by tests. */
  now?: Date;
}

/**
 * Asks every askable node one verb in parallel and keeps every answer —
 * the fleet-wide lists' one step (routes/observe.ts, the E2B list in
 * routes/e2b.ts). Unlike the finder, which wants exactly one yes, a
 * merged answer wants everyone, and a node that does not answer is not
 * a reason to refuse the rest: the operator reads the fleet's sandboxes
 * with one node in trouble, and reads which one.
 */
export async function askEach<T>(
  fleet: Fleet,
  ask: AskVerb,
  each: EachAsk<T>,
): Promise<Merged<T>> {
  const now = each.now ?? new Date();
  const silent: SilentNode[] = [];
  const asked: NodeState[] = [];
  for (const node of fleet.all()) {
    const judged = askability(node, now);
    if (judged.ask) asked.push(node);
    else if (judged.why !== null)
      silent.push({ nodeId: node.id, why: judged.why });
  }
  const results = await Promise.all(
    asked.map(async (node) => ({
      node,
      asked: await ask(
        node,
        typeof each.verb === 'string' ? each.verb : each.verb(node),
        each.body,
        each.schema,
        { timeoutMs: MERGE_TIMEOUT_MS, ...each.options },
      ),
    })),
  );
  const answers: Merged<T>['answers'] = [];
  for (const { node, asked: answer } of results) {
    if (answer.kind === 'answer') {
      answers.push({ node, value: answer.value, headers: answer.headers });
    } else {
      silent.push({ nodeId: node.id, why: answer.why });
    }
  }
  const byId = <N extends { nodeId: string } | { node: NodeState }>(
    a: N,
    b: N,
  ) => idOf(a).localeCompare(idOf(b));
  answers.sort(byId);
  silent.sort(byId);
  return { answers, silent };
}

function idOf(entry: { nodeId: string } | { node: NodeState }): string {
  return 'nodeId' in entry ? entry.nodeId : entry.node.id;
}
