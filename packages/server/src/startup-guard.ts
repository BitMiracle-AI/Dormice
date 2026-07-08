import type { ContainerState } from './executor/executor';

/**
 * The identity check between "this ledger" and "this reality", run once at
 * boot before the first reconcile. Reconciliation trusts that the ledger it
 * reads and the reality it observes belong together, and destroys whatever
 * the ledger disowns — so the two mistakes that break the pairing itself
 * must refuse the boot instead of reconciling:
 *
 * - An empty ledger facing live containers or disks is almost never a fresh
 *   install. It is a daemon started in the wrong directory (a relative
 *   DORMICE_DB_PATH opened a brand-new ledger) or with the wrong executor.
 *   Reconciling would destroy every sandbox on the machine as an orphan —
 *   user data physically erased by one operations typo.
 * - A populated ledger facing a completely empty docker reality means the
 *   daemon cannot see the sandboxes it owns: wrong DORMICE_DATA_DIR, wrong
 *   docker socket, wrong machine. Reconciling would erase the whole ledger,
 *   and the next correctly-configured boot would then destroy the real
 *   sandboxes as orphans. The fake executor is exempt — its reality lives
 *   in memory and is legitimately empty on every boot.
 *
 * Returns the refusal message, or null when the pairing looks sane.
 */
export function startupGuard(input: {
  ledgerCount: number;
  containers: ReadonlyMap<string, ContainerState>;
  disks: readonly string[];
  executor: 'fake' | 'docker';
}): string | null {
  const { ledgerCount, containers, disks, executor } = input;

  const found = new Set([...containers.keys(), ...disks]);
  if (ledgerCount === 0 && found.size > 0) {
    const preview = [...found].slice(0, 3).join(', ');
    return (
      `refusing to start: the ledger is empty, but ${found.size} sandbox(es) exist on this machine (${preview}${found.size > 3 ? ', …' : ''}). ` +
      'An empty ledger meeting a populated reality usually means the wrong DORMICE_DB_PATH or DORMICE_EXECUTOR — reconciling would destroy every one of these sandboxes as an orphan. ' +
      'Point the daemon at the ledger that owns them; if they are truly abandoned, remove them yourself first ' +
      '(docker ps -a --filter label=dormice.sandbox; docker rm -f <ids>; delete their images under <DORMICE_DATA_DIR>/disks).'
    );
  }

  if (
    executor === 'docker' &&
    ledgerCount > 0 &&
    containers.size === 0 &&
    disks.length === 0
  ) {
    return (
      `refusing to start: the ledger knows ${ledgerCount} sandbox(es), but reality is completely empty — this daemon cannot see the sandboxes it owns. ` +
      'That usually means the wrong DORMICE_DATA_DIR, docker socket, or machine. Starting anyway would erase the ledger and leave the real sandboxes to be destroyed as orphans later.'
    );
  }

  return null;
}
