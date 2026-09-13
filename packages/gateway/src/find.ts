import type { CacheEntry, NameCache } from './cache';
import type { Fleet, NodeState } from './fleet';
import type { AskNode, LookupQuery } from './lookup';

/**
 * Where a sandbox is, adjudicated once for every face:
 *   one       exactly one node holds it — route there
 *   conflict  several nodes hold it — refused, never guessed about (an
 *             operator destroys one copy directly on its node)
 *   none      every node answered, none holds it — the name is new
 *   unsure    no node holds it as far as anyone answered, but a node did
 *             not answer, so "new" cannot be proven: a name that lives
 *             only on a silent node must not be built a second time
 *             elsewhere (design record #28: a 503 with Retry-After, the
 *             retry is the application's)
 */
export type Found =
  | { kind: 'one'; node: NodeState; id: string; name: string | null }
  | { kind: 'conflict'; nodeIds: string[] }
  | { kind: 'none' }
  | { kind: 'unsure'; silent: Array<{ nodeId: string; why: string }> };

export interface FinderLog {
  warn(obj: unknown, msg: string): void;
}

/**
 * Finds a sandbox by asking. The cache answers first; on a miss every
 * node in the fleet is asked in parallel (lookup.ts), and exactly one
 * "yes" wins — the sandbox is wherever it says it is, whether or not some
 * other node was slow to say no. Down nodes are asked like any other:
 * the reading a node last reported says where NOT to place, never where
 * a sandbox is; a node that has missed its check-ins but still answers a
 * lookup still holds its sandboxes.
 */
export class Finder {
  constructor(
    private readonly fleet: Fleet,
    readonly cache: NameCache,
    private readonly ask: AskNode,
    private readonly log: FinderLog,
  ) {}

  byName(name: string): Promise<Found> {
    return this.find(this.cache.getByName(name), { name });
  }

  byId(id: string): Promise<Found> {
    return this.find(this.cache.getById(id), { id });
  }

  private async find(
    cached: CacheEntry | undefined,
    query: LookupQuery,
  ): Promise<Found> {
    if (cached !== undefined) {
      const node = this.fleet.get(cached.nodeId);
      // A node the operator removed while the entry was cached: the
      // entry is stale by definition, and the fleet is asked afresh.
      if (node !== undefined) {
        return { kind: 'one', node, id: cached.id, name: cached.name };
      }
      this.cache.evict(cached);
    }
    const members = this.fleet.all();
    const answers = await Promise.all(
      members.map(async (node) => ({
        node,
        answer: await this.ask(node, query),
      })),
    );
    const found = answers.flatMap(({ node, answer }) =>
      answer.kind === 'found' ? [{ node, answer }] : [],
    );
    const first = found[0];
    if (found.length === 1 && first !== undefined) {
      const entry = {
        id: first.answer.id,
        name: first.answer.name,
        nodeId: first.node.id,
      };
      this.cache.put(entry);
      return { kind: 'one', node: first.node, id: entry.id, name: entry.name };
    }
    if (found.length > 1) {
      return {
        kind: 'conflict',
        nodeIds: found.map((f) => f.node.id).sort(),
      };
    }
    const silent = answers.flatMap(({ node, answer }) =>
      answer.kind === 'silent' ? [{ nodeId: node.id, why: answer.why }] : [],
    );
    if (silent.length > 0) {
      this.log.warn(
        { query, silent },
        'lookup: a node did not answer; a name it may hold cannot be treated as new',
      );
      return { kind: 'unsure', silent };
    }
    return { kind: 'none' };
  }

  /**
   * After a cached node answered 404 for a name: is the sandbox really
   * gone from it? A node's 404 is not "no such sandbox" by itself —
   * readFile answers 404 for a missing path too — so the node is asked
   * the one question that means exactly that, and only a plain "absent"
   * evicts. Silence keeps the entry: the node may be down, and its
   * sandboxes are still there. Off the request path (the 404 has already
   * been relayed); the next request for the name asks the fleet afresh.
   */
  async verify(entry: CacheEntry): Promise<void> {
    const node = this.fleet.get(entry.nodeId);
    if (node === undefined) {
      this.cache.evict(entry);
      return;
    }
    const answer = await this.ask(node, { id: entry.id });
    if (answer.kind === 'absent') this.cache.evict(entry);
  }
}
