import type { NodeConfigBundle } from '@dormice/shared';
import type { Db } from './db/db';
import {
  applyNodeConfig,
  readConfigVersion,
  readRuntimeSettings,
  readSwapTarget,
} from './db/settings';
import type { Executor } from './executor/executor';
import type { KeyedQueue } from './keyed-queue';
import { sweepPidsLimit } from './pids-sweep';
import type { SwapControl } from './swap';

export interface ConfigApplierDeps {
  db: Db;
  executor: Executor;
  locks: KeyedQueue;
  /** Managed swap, where the host has it (main.ts decides); absent, the target is stored and nothing else. */
  swap?: SwapControl;
  log: {
    info(obj: unknown, msg: string): void;
    warn(obj: unknown, msg: string): void;
    error(obj: unknown, msg: string): void;
  };
  /** The heartbeat watchdog's ear, for the pids sweep. */
  beat?: () => void;
}

/**
 * A bundle from the gateway, made real on this node. The ledger copy
 * first (db/settings.ts applyNodeConfig — from that instant every birth,
 * wake, scan tick and proxy request reads the new values), then the two
 * knobs with a reality on the host that a write alone does not move: the
 * pids cap on the shells running right now (a cgroup write their
 * processes never notice; pids-sweep.ts) and the managed swap target
 * (grow now, shrink at the next reboot; swap.ts). Each runs only when its
 * value moved — a bundle that changed a template, the archive store or
 * the domain touches no shell — and never after the first copy: at boot,
 * main.ts's own sweep and swap reconcile follow. Their failures are
 * logged, never thrown: the copy is applied and the version reported
 * either way; a shell the runtime refuses converges at its next wake, a
 * swap block that failed to mount is retried at the next boot — capacity,
 * not correctness.
 */
export async function applyConfig(
  bundle: NodeConfigBundle,
  deps: ConfigApplierDeps,
): Promise<void> {
  const { db, executor, locks, swap, log, beat } = deps;
  const before =
    readConfigVersion(db) === null
      ? null
      : {
          pidsLimit: readRuntimeSettings(db).pidsLimit,
          swapGb: readSwapTarget(db),
        };
  applyNodeConfig(db, bundle);
  log.info(
    {
      version: bundle.version,
      from: before === null ? null : undefined,
      templates: bundle.templates.length,
      pidsLimit: bundle.settings.pidsLimit,
      swapGb: bundle.node.swapGb,
      archive: bundle.settings.s3 === null ? 'off' : bundle.settings.s3.bucket,
      sandboxDomain: bundle.settings.sandboxDomain,
    },
    before === null
      ? 'first configuration copy applied from the gateway'
      : 'configuration applied from the gateway',
  );
  if (before === null) return;
  if (bundle.settings.pidsLimit !== before.pidsLimit) {
    const sweep = await sweepPidsLimit(db, executor, locks, beat);
    if (sweep.failures.length > 0) {
      log.warn(
        sweep,
        `pids cap moved to ${bundle.settings.pidsLimit}; ${sweep.failures.length} running shell(s) kept the old cap until their next wake`,
      );
    } else {
      log.info(sweep, `pids cap moved to ${bundle.settings.pidsLimit}`);
    }
  }
  if (swap !== undefined && bundle.node.swapGb !== before.swapGb) {
    try {
      await swap.reconcile(bundle.node.swapGb);
    } catch (error) {
      log.error(error, 'swap reconcile after a configuration change failed');
    }
  }
}
