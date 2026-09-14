import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { migrateDb, openDb } from './db/db';
import { Fleet, STARTUP_GRACE_MS } from './fleet';
import type { AskVerb } from './lookup';
import { askability, askEach, MERGE_TIMEOUT_MS } from './merge';
import { checkInOf } from './testing';

// Who a merged answer asks, and what it says of the rest — the pure rules,
// with a scripted asker. The wire (a real node, a real timeout) is
// app.test.ts's.

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const NOW = new Date('2026-09-15T00:00:00.000Z');

function fleetAt(startedAt: Date) {
  const db = openDb(':memory:');
  migrateDb(db, MIGRATIONS);
  return new Fleet(db, startedAt);
}

describe('askability', () => {
  it('a node that checked in and runs a configuration is asked; one down for two of its intervals is not, with the reason', () => {
    const fleet = fleetAt(NOW);
    const a = fleet.checkIn(checkInOf('a', 'http://a:80'), NOW);
    if ('refused' in a) throw new Error(a.refused);
    expect(askability(a.node, NOW, fleet.startedAt)).toEqual({ ask: true });
    const later = new Date(NOW.getTime() + 31_000);
    expect(askability(a.node, later, fleet.startedAt)).toEqual({
      ask: false,
      why: 'has not checked in for 31s',
    });
  });

  it('a node awaiting its first configuration is not asked: holding nothing, nothing is said; holding sandboxes, it is named as not listening', () => {
    const fleet = fleetAt(NOW);
    const empty = fleet.checkIn(
      checkInOf('b', 'http://b:80', { configVersion: null, active: 0 }),
      NOW,
    );
    if ('refused' in empty) throw new Error(empty.refused);
    expect(askability(empty.node, NOW, fleet.startedAt)).toEqual({
      ask: false,
      why: null,
    });
    fleet.checkIn(
      checkInOf('b', 'http://b:80', { configVersion: null, active: 4 }),
      NOW,
    );
    expect(askability(empty.node, NOW, fleet.startedAt)).toEqual({
      ask: false,
      why: expect.stringMatching(/not listening — it holds 4 sandboxes/),
    });
  });

  it('after a gateway start a node not yet heard from is asked for the grace period, and is down after it', () => {
    const db = openDb(':memory:');
    migrateDb(db, MIGRATIONS);
    new Fleet(db, NOW).checkIn(checkInOf('c', 'http://c:80'), NOW);
    // A restart over the same rows: c is known, silent so far.
    const restarted = new Fleet(db, NOW);
    const c = restarted.get('c');
    if (!c) throw new Error('row lost');
    expect(
      askability(c, new Date(NOW.getTime() + STARTUP_GRACE_MS - 1), NOW),
    ).toEqual({ ask: true });
    expect(
      askability(c, new Date(NOW.getTime() + STARTUP_GRACE_MS), NOW),
    ).toEqual({
      ask: false,
      why: 'has not checked in since the gateway started',
    });
  });
});

describe('askEach', () => {
  const answerSchema = z.object({ items: z.array(z.string()) });

  it('asks every askable node with the merge timeout, keeps every answer in node-id order, and names the silent ones', async () => {
    const fleet = fleetAt(NOW);
    for (const id of ['c', 'a', 'b', 'd']) {
      fleet.checkIn(checkInOf(id, `http://${id}:80`), NOW);
    }
    // d fell silent; b is booting with sandboxes; nobody dials either.
    const d = fleet.get('d');
    if (!d) throw new Error('node lost');
    d.lastCheckInAt = new Date(NOW.getTime() - 40_000);
    fleet.checkIn(
      checkInOf('b', 'http://b:80', { configVersion: null, active: 2 }),
      NOW,
    );
    const asked: Array<{ id: string; verb: string; timeoutMs?: number }> = [];
    const ask: AskVerb = async (node, verb, _body, schema, options) => {
      asked.push({ id: node.id, verb, timeoutMs: options?.timeoutMs });
      if (node.id === 'c') return { kind: 'silent', why: 'ECONNRESET' };
      return {
        kind: 'answer',
        value: schema.parse({ items: [`${node.id}-1`] }),
        headers: new Headers({ 'x-next-token': '7' }),
      };
    };
    const merged = await askEach(
      fleet,
      ask,
      NOW,
      (node) => `list?node=${node.id}`,
      {},
      answerSchema,
    );
    expect(asked).toEqual([
      { id: 'c', verb: 'list?node=c', timeoutMs: MERGE_TIMEOUT_MS },
      { id: 'a', verb: 'list?node=a', timeoutMs: MERGE_TIMEOUT_MS },
    ]);
    expect(merged.answers.map((a) => a.node.id)).toEqual(['a']);
    expect(merged.answers[0]?.value).toEqual({ items: ['a-1'] });
    expect(merged.answers[0]?.headers.get('x-next-token')).toBe('7');
    expect(merged.silent).toEqual([
      { nodeId: 'b', why: expect.stringMatching(/not listening/) },
      { nodeId: 'c', why: 'ECONNRESET' },
      { nodeId: 'd', why: 'has not checked in for 40s' },
    ]);
  });

  it('an empty fleet answers nothing and nobody is silent', async () => {
    const merged = await askEach(
      fleetAt(NOW),
      async () => {
        throw new Error('nobody to ask');
      },
      NOW,
      'list',
      {},
      answerSchema,
    );
    expect(merged).toEqual({ answers: [], silent: [] });
  });
});
