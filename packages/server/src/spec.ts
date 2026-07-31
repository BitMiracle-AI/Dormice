import type { SandboxResourceDefaults, SandboxSpec } from '@dormice/shared';
import type { SandboxRow } from './db/schema';

/**
 * The one arbiter of "which numbers are in force for this sandbox": each
 * NULL column collapses onto the global default, per knob. Every reader —
 * the wire views (native and E2B), the wake convergence, expandDisk's
 * grow-only check — resolves through here, so the fallback rule cannot
 * fork.
 */
export function resolveSpec(
  row: SandboxRow,
  defaults: SandboxResourceDefaults,
): SandboxSpec {
  return {
    cpus: row.cpus ?? defaults.cpus,
    memoryGb: row.memoryGb ?? defaults.memoryGb,
    diskGb: row.diskGb ?? defaults.diskGb,
  };
}

/**
 * The row's own knobs as ShellOptions fields: pinned numbers travel,
 * NULLs stay absent so the executor's own live default (resources()) is
 * the single fallback at the moment of birth. Passing resolved numbers
 * instead would freeze the global default into the call and quietly
 * bypass a console edit that lands mid-flight.
 */
export function shellSpecOf(row: SandboxRow): {
  cpus?: number;
  memoryGb?: number;
} {
  return {
    ...(row.cpus !== null ? { cpus: row.cpus } : {}),
    ...(row.memoryGb !== null ? { memoryGb: row.memoryGb } : {}),
  };
}
