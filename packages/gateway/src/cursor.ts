/**
 * The E2B list's cursor across nodes. E2B's v2 list pages by an opaque
 * `x-next-token` the client hands back verbatim; a node's token is its own
 * offset into its own newest-first list (the daemon's e2b/control.ts). At
 * the gateway one page is drawn from every node, so the cursor is every
 * node's offset at once: base64url of `{ v: 1, o: { <nodeId>: <offset> } }`.
 * A node not in it starts at 0; a node in it that has since been removed
 * is ignored. Opaque to the SDK, which never reads it.
 */
export type Offsets = Record<string, number>;

const VERSION = 1;

export function encodeCursor(offsets: Offsets): string {
  return Buffer.from(JSON.stringify({ v: VERSION, o: offsets })).toString(
    'base64url',
  );
}

/** The offsets a token carries, or null for anything but a token this gateway minted. */
export function decodeCursor(token: string): Offsets | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { v, o } = parsed as { v?: unknown; o?: unknown };
  if (v !== VERSION || typeof o !== 'object' || o === null) return null;
  const offsets: Offsets = {};
  for (const [nodeId, offset] of Object.entries(o)) {
    if (!Number.isInteger(offset) || (offset as number) < 0) return null;
    offsets[nodeId] = offset as number;
  }
  return offsets;
}

/** One node's page: what it answered from its offset, and whether it said there was more after it (its own x-next-token). */
export interface NodePage<T> {
  nodeId: string;
  items: T[];
  more: boolean;
}

export interface MergedPage<T> {
  items: T[];
  /** The next page's cursor, or null when every node is exhausted. */
  next: Offsets | null;
}

/**
 * One page across nodes: every node's page, newest first (the daemon's
 * order — `startedAt` descending; ties by id so the order is the same
 * every time), cut at `limit`. Each node's offset advances by what this
 * page took from its page, so what it did not take is at the front of
 * that node's next page. There is a next page while any node has items
 * this page did not take, or said it had more beyond the page it sent.
 */
export function mergePages<T extends { sandboxID: string; startedAt: string }>(
  pages: NodePage<T>[],
  offsets: Offsets,
  limit: number,
): MergedPage<T> {
  const tagged = pages.flatMap((page) =>
    page.items.map((item) => ({ nodeId: page.nodeId, item })),
  );
  tagged.sort((a, b) =>
    a.item.startedAt === b.item.startedAt
      ? a.item.sandboxID.localeCompare(b.item.sandboxID)
      : a.item.startedAt < b.item.startedAt
        ? 1
        : -1,
  );
  const taken = tagged.slice(0, limit);
  const used = new Map<string, number>();
  for (const { nodeId } of taken) used.set(nodeId, (used.get(nodeId) ?? 0) + 1);
  const next: Offsets = { ...offsets };
  let more = false;
  for (const page of pages) {
    const took = used.get(page.nodeId) ?? 0;
    next[page.nodeId] = (offsets[page.nodeId] ?? 0) + took;
    if (took < page.items.length || (page.more && took === page.items.length)) {
      more = true;
    }
  }
  return { items: taken.map((t) => t.item), next: more ? next : null };
}
