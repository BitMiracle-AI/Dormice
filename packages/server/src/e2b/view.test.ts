import { describe, expect, it } from 'vitest';
import type { SandboxRow } from '../db/schema';
import { e2bView } from './view';

function row(overrides: Partial<SandboxRow>): SandboxRow {
  return {
    id: 'sbx-1',
    name: 'alice',
    state: 'active',
    nodeId: 'node-test',
    freezeAfterSeconds: 60,
    stopAfterSeconds: null,
    archiveAfterSeconds: null,
    template: null,
    createdAt: '2026-07-09T00:00:00.000Z',
    lastActiveAt: '2026-07-09T00:00:00.000Z',
    metadata: null,
    envs: null,
    deadlineAt: null,
    onDeadline: null,
    pausedByUser: false,
    ...overrides,
  };
}

const NOW = new Date('2026-07-09T12:00:00.000Z');

describe('e2bView', () => {
  it('reports the logical state, not the physical one: frozen and stopped still read running', () => {
    // Passive cooling is Dormice's implementation detail — until a deadline
    // or an explicit pause says otherwise, the sandbox is protocol-alive.
    expect(e2bView(row({ state: 'active' }), NOW)).toBe('running');
    expect(e2bView(row({ state: 'frozen' }), NOW)).toBe('running');
    expect(e2bView(row({ state: 'stopped' }), NOW)).toBe('running');
  });

  it('a future deadline is still running; an expired one acts', () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    const past = new Date(NOW.getTime() - 1).toISOString();
    expect(e2bView(row({ deadlineAt: future, onDeadline: 'kill' }), NOW)).toBe(
      'running',
    );
    expect(e2bView(row({ deadlineAt: past, onDeadline: 'kill' }), NOW)).toBe(
      'dead',
    );
    expect(e2bView(row({ deadlineAt: past, onDeadline: 'pause' }), NOW)).toBe(
      'paused',
    );
  });

  it('an explicit pause reads paused whatever the physical state', () => {
    expect(e2bView(row({ pausedByUser: true, state: 'active' }), NOW)).toBe(
      'paused',
    );
    expect(e2bView(row({ pausedByUser: true, state: 'frozen' }), NOW)).toBe(
      'paused',
    );
  });

  it('an expired kill deadline outranks an explicit pause: dead is dead', () => {
    const past = new Date(NOW.getTime() - 1).toISOString();
    expect(
      e2bView(
        row({ deadlineAt: past, onDeadline: 'kill', pausedByUser: true }),
        NOW,
      ),
    ).toBe('dead');
  });
});
