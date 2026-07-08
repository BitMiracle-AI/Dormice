import { describe, expect, it } from 'vitest';
import type { ContainerState } from './executor/executor';
import { startupGuard } from './startup-guard';

function containers(...ids: string[]): Map<string, ContainerState> {
  return new Map(ids.map((id) => [id, 'running' as const]));
}

describe('startupGuard', () => {
  it('passes a fresh install: empty ledger, empty reality', () => {
    expect(
      startupGuard({
        ledgerCount: 0,
        containers: containers(),
        disks: [],
        executor: 'docker',
      }),
    ).toBeNull();
  });

  it('passes a normal restart: populated ledger, populated reality', () => {
    expect(
      startupGuard({
        ledgerCount: 2,
        containers: containers('a', 'b'),
        disks: ['a', 'b'],
        executor: 'docker',
      }),
    ).toBeNull();
  });

  it('refuses an empty ledger facing live containers', () => {
    const message = startupGuard({
      ledgerCount: 0,
      containers: containers('a'),
      disks: ['a'],
      executor: 'docker',
    });
    expect(message).toMatch(/refusing to start/);
    expect(message).toMatch(/DORMICE_DB_PATH/);
  });

  it('refuses an empty ledger facing leftover disks alone', () => {
    // Stopped sandboxes whose containers were pruned: only disks remain,
    // and those disks are user data. Reconciling would remove them.
    const message = startupGuard({
      ledgerCount: 0,
      containers: containers(),
      disks: ['a', 'b'],
      executor: 'docker',
    });
    expect(message).toMatch(/refusing to start/);
  });

  it('refuses a populated ledger facing a completely empty docker reality', () => {
    const message = startupGuard({
      ledgerCount: 3,
      containers: containers(),
      disks: [],
      executor: 'docker',
    });
    expect(message).toMatch(/refusing to start/);
    expect(message).toMatch(/DORMICE_DATA_DIR/);
  });

  it('lets the fake executor restart over an old ledger', () => {
    // The fake's reality is in-memory: empty on every boot, by design.
    expect(
      startupGuard({
        ledgerCount: 3,
        containers: containers(),
        disks: [],
        executor: 'fake',
      }),
    ).toBeNull();
  });

  it('does not refuse a docker ledger whose containers were pruned but disks remain', () => {
    // Reality is not "completely empty": the disks are visible, the daemon
    // is looking at the right machine. The reconciler handles the rest.
    expect(
      startupGuard({
        ledgerCount: 2,
        containers: containers(),
        disks: ['a', 'b'],
        executor: 'docker',
      }),
    ).toBeNull();
  });
});
