import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, mergePages } from './cursor';

// The E2B list's cursor across nodes and the page it draws — pure.

const item = (id: string, startedAt: string) => ({ sandboxID: id, startedAt });

describe('the cursor', () => {
  it('round-trips every node offset and refuses anything it did not mint', () => {
    const offsets = { 'node-b': 3, 'node-c': 0 };
    expect(decodeCursor(encodeCursor(offsets))).toEqual(offsets);
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('12')).toBeNull();
    expect(decodeCursor('not base64 json')).toBeNull();
    expect(
      decodeCursor(Buffer.from('{"v":2,"o":{}}').toString('base64url')),
    ).toBeNull();
    expect(
      decodeCursor(Buffer.from('{"v":1,"o":{"a":-1}}').toString('base64url')),
    ).toBeNull();
    expect(
      decodeCursor(Buffer.from('{"v":1,"o":{"a":1.5}}').toString('base64url')),
    ).toBeNull();
    expect(
      decodeCursor(Buffer.from('{"v":1,"o":{}}').toString('base64url')),
    ).toEqual({});
  });
});

describe('mergePages', () => {
  it('draws one page newest first across nodes, advances each node by what it took, and stops when every node is exhausted', () => {
    const b = {
      nodeId: 'b',
      items: [
        item('b3', '2026-09-15T00:03:00Z'),
        item('b1', '2026-09-15T00:01:00Z'),
      ],
      more: false,
    };
    const c = {
      nodeId: 'c',
      items: [item('c2', '2026-09-15T00:02:00Z')],
      more: false,
    };
    const first = mergePages([b, c], {}, 2);
    expect(first.items.map((i) => i.sandboxID)).toEqual(['b3', 'c2']);
    expect(first.next).toEqual({ b: 1, c: 1 });
    // The next page: b answers from offset 1, c has nothing left.
    const second = mergePages(
      [
        { ...b, items: [b.items[1] as (typeof b.items)[number]] },
        { ...c, items: [] },
      ],
      first.next ?? {},
      2,
    );
    expect(second.items.map((i) => i.sandboxID)).toEqual(['b1']);
    expect(second.next).toBeNull();
  });

  it('a node that said it had more beyond the page it sent keeps the cursor alive even when the page took all of it', () => {
    const b = {
      nodeId: 'b',
      items: [item('b9', '2026-09-15T00:09:00Z')],
      more: true,
    };
    const page = mergePages([b], { b: 4 }, 5);
    expect(page.items).toHaveLength(1);
    expect(page.next).toEqual({ b: 5 });
  });

  it('equal timestamps order by id, the same every time', () => {
    const at = '2026-09-15T00:00:00Z';
    const page = mergePages(
      [
        { nodeId: 'c', items: [item('m', at), item('a', at)], more: false },
        { nodeId: 'b', items: [item('k', at)], more: false },
      ],
      {},
      10,
    );
    expect(page.items.map((i) => i.sandboxID)).toEqual(['a', 'k', 'm']);
    expect(page.next).toBeNull();
  });
});
