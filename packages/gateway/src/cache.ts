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
 */
export interface CacheEntry {
  id: string;
  /** Null for a sandbox learned by id alone (an unnamed E2B create) until a lookup names it. */
  name: string | null;
  nodeId: string;
}

export class NameCache {
  private readonly byName = new Map<string, CacheEntry>();
  private readonly byId = new Map<string, CacheEntry>();

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
    this.byId.set(entry.id, entry);
  }

  getByName(name: string): CacheEntry | undefined {
    return this.byName.get(name);
  }

  getById(id: string): CacheEntry | undefined {
    return this.byId.get(id);
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
