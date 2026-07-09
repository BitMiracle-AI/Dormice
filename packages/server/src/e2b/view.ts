import type { SandboxRow } from '../db/schema';

export type E2bState = 'running' | 'paused' | 'dead';

/**
 * The single arbiter of what the E2B surface says about a sandbox.
 *
 * It reports the LOGICAL state, never the physical one: a sandbox the idle
 * scanner froze behind the caller's back is still `running` here — passive
 * freezing is Dormice's implementation detail (50ms wake, invisible to the
 * caller), and protocol-wise the sandbox is alive until its deadline says
 * otherwise. `paused` is reserved for what E2B means by it: an explicit
 * pause, or an expired deadline whose action is pause. An expired kill-type
 * deadline reports `dead` — the sandbox is protocol-gone the moment the
 * deadline passes; the scanner's physical teardown follows on its own beat.
 */
export function e2bView(row: SandboxRow, now: Date): E2bState {
  if (row.deadlineAt !== null && Date.parse(row.deadlineAt) <= now.getTime()) {
    return row.onDeadline === 'pause' ? 'paused' : 'dead';
  }
  if (row.pausedByUser) return 'paused';
  return 'running';
}
