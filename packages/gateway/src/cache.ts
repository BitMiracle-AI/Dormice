/**
 * Where a sandbox was last found: name and id → node. A cache, not a
 * directory — nothing here is authoritative, the ledger of the node that
 * runs the sandbox is — so it is never persisted, never reconciled and
 * never written from anything but a node's own answer: a lookup that said
 * yes, a create that answered 2xx. It is dropped on a destroy the gateway
 * relayed, on a node's 404 that a fresh lookup confirms (find.ts verify),
 * and wholesale for a node an operator removed. An entry that is wrong
 * costs one misrouted request, whose answer evicts it; a cache that is
 * lost costs one extra round of questions per name.
 *
 * Bounded, least recently used first. A node deletes rows on its own — an
 * E2B deadline kill is the scanner's routine — and tells no gateway, so
 * an unbounded map would keep an entry for every sandbox ever created
 * through this process, for as long as it lived: an unnamed E2B create
 * every minute is half a million dead entries a year. The bound is
 * generous next to a fleet's live population (Beijing holds some fifteen
 * thousand rows, 2026-09), and past it the entry nobody has asked about
 * for longest goes; asked about again, it costs the one round of
 * questions any miss costs.
 */
export interface CacheEntry {
  id: string;
  /** Null for a sandbox learned by id alone (an unnamed E2B create) until a lookup names it. */
  name: string | null;
  nodeId: string;
}

export const CACHE_LIMIT = 100_000;

export class NameCache {
  private readonly byName = new Map<string, CacheEntry>();
  /** Insertion order is recency: a hit re-inserts, and the first key is the least recently used. */
  private readonly byId = new Map<string, CacheEntry>();

  constructor(private readonly limit = CACHE_LIMIT) {}

  put(entry: CacheEntry): void {
    // A name that moves to a new id (destroyed and re-acquired elsewhere
    // while this gateway did not see the destroy) drops the old entry
    // whole, so no id points at a node that no longer holds it.
    if (entry.name !== null) {
      const previous = this.byName.get(entry.name);
      if (previous !== undefined && previous.id !== entry.id) {
        this.byId.delete(previous.id);
      }
      this.byName.set(entry.name, entry);
    }
    const known = this.byId.get(entry.id);
    if (
      known?.name !== null &&
      known?.name !== undefined &&
      known.name !== entry.name
    ) {
      this.byName.delete(known.name);
    }
    this.byId.delete(entry.id);
    this.byId.set(entry.id, entry);
    if (this.byId.size > this.limit) {
      const oldest = this.byId.values().next().value;
      if (oldest !== undefined) this.evict(oldest);
    }
  }

  getByName(name: string): CacheEntry | undefined {
    const entry = this.byName.get(name);
    if (entry !== undefined) this.touch(entry);
    return entry;
  }

  getById(id: string): CacheEntry | undefined {
    const entry = this.byId.get(id);
    if (entry !== undefined) this.touch(entry);
    return entry;
  }

  /** Marks the entry as just used: back to the end of the recency order. */
  private touch(entry: CacheEntry): void {
    this.byId.delete(entry.id);
    this.byId.set(entry.id, entry);
  }

  evict(entry: CacheEntry): void {
    if (entry.name !== null && this.byName.get(entry.name)?.id === entry.id) {
      this.byName.delete(entry.name);
    }
    if (this.byId.get(entry.id)?.nodeId === entry.nodeId) {
      this.byId.delete(entry.id);
    }
  }

  /** Everything that pointed at a node the operator removed. */
  evictNode(nodeId: string): number {
    let evicted = 0;
    for (const entry of [...this.byId.values()]) {
      if (entry.nodeId === nodeId) {
        this.evict(entry);
        evicted += 1;
      }
    }
    return evicted;
  }

  get size(): number {
    return this.byId.size;
  }
}
