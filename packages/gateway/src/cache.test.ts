import { describe, expect, it } from 'vitest';
import { NameCache } from './cache';

const on = (id: string, name: string | null, nodeId = 'a') => ({
  id,
  name,
  nodeId,
});

describe('NameCache', () => {
  it('answers by name and by id; a name that moves to a new id drops the old id whole; an id that changes name frees the old name', () => {
    const cache = new NameCache();
    cache.put(on('sb-1', 'alice'));
    expect(cache.getByName('alice')?.id).toBe('sb-1');
    expect(cache.getById('sb-1')?.name).toBe('alice');
    cache.put(on('sb-2', 'alice', 'b'));
    expect(cache.getById('sb-1')).toBeUndefined();
    expect(cache.getByName('alice')?.nodeId).toBe('b');
    cache.put(on('sb-2', 'alicia', 'b'));
    expect(cache.getByName('alice')).toBeUndefined();
    expect(cache.getByName('alicia')?.id).toBe('sb-2');
    expect(cache.size).toBe(1);
  });

  it('evict drops one entry, both handles; evictNode drops every entry of a node and counts them', () => {
    const cache = new NameCache();
    cache.put(on('sb-1', 'alice'));
    cache.put(on('sb-2', null));
    cache.put(on('sb-3', 'carol', 'b'));
    cache.evict(on('sb-1', 'alice'));
    expect(cache.getByName('alice')).toBeUndefined();
    expect(cache.getById('sb-1')).toBeUndefined();
    expect(cache.evictNode('a')).toBe(1);
    expect(cache.getById('sb-2')).toBeUndefined();
    expect(cache.getByName('carol')?.id).toBe('sb-3');
    expect(cache.size).toBe(1);
  });

  it('is bounded: past the limit the entry least recently asked about goes, both handles; one just read stays', () => {
    const cache = new NameCache(3);
    cache.put(on('sb-1', 'alice'));
    cache.put(on('sb-2', 'bob'));
    cache.put(on('sb-3', null));
    // alice is the oldest write, but she was just asked about.
    expect(cache.getByName('alice')).toBeDefined();
    cache.put(on('sb-4', 'dora'));
    expect(cache.size).toBe(3);
    expect(cache.getByName('bob')).toBeUndefined();
    expect(cache.getById('sb-2')).toBeUndefined();
    expect(cache.getByName('alice')?.id).toBe('sb-1');
    expect(cache.getById('sb-3')).toBeDefined();
    expect(cache.getByName('dora')).toBeDefined();
    // A re-put of a known id is a use too, not a second entry.
    cache.put(on('sb-3', 'cathy'));
    expect(cache.size).toBe(3);
    cache.put(on('sb-5', 'eve'));
    expect(cache.getByName('alice')).toBeUndefined();
    expect(cache.getByName('cathy')?.id).toBe('sb-3');
  });
});
