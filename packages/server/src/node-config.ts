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
  /** This node's own DORMICE_BASE_IMAGE, the base image's old home — what a bundle naming none leaves in force, said as a warning. */
  baseImageFallback?: string;
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
 *
 * And the bundle's images are fetched ahead (prefetchImages), in the
 * background: the check-in that carried the bundle is not held for a
 * pull — a template of tens of GiB would take minutes, and a node that
 * stops checking in for minutes is read as down.
 */
export async function applyConfig(
  bundle: NodeConfigBundle,
  deps: ConfigApplierDeps,
): Promise<void> {
  const { db, executor, locks, swap, log, beat, baseImageFallback } = deps;
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
  if (bundle.settings.baseImage === null && baseImageFallback !== undefined) {
    log.warn(
      { fallback: baseImageFallback },
      'the fleet settings name no base image — template-less sandboxes on this node boot DORMICE_BASE_IMAGE from its env; set baseImage at the gateway (console › settings) so every node shares one',
    );
  }
  void prefetchImages(bundle, executor, log);
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

/**
 * Every image a bundle names — the fleet's base image and each template's
 * — made present on this host ahead of the first sandbox that needs it
 * (executor ensureImage: pulled from the fleet registry when absent, a
 * word when present). One at a time, in the background of the check-in
 * that brought the bundle: a first sandbox that finds its image already
 * here starts in seconds where the pull alone would have taken minutes,
 * and a node joining the fleet stages its images with no operator's
 * hand. A pull that fails is one warning, naming the image and why, and
 * the bundle stands: the first sandbox that needs the image tries the
 * pull again and fails with the same words if it still cannot be had.
 * Two bundles in quick succession run two of these; the executor shares
 * one pull per image between them.
 */
export async function prefetchImages(
  bundle: NodeConfigBundle,
  executor: Executor,
  log: ConfigApplierDeps['log'],
): Promise<void> {
  const wanted = new Set<string>();
  if (bundle.settings.baseImage !== null) wanted.add(bundle.settings.baseImage);
  for (const template of bundle.templates) wanted.add(template.image);
  for (const image of wanted) {
    try {
      const outcome = await executor.ensureImage(image);
      if (outcome === 'pulled') {
        log.info(
          { image },
          'image pulled ahead of the first sandbox to need it',
        );
      }
    } catch (error) {
      log.warn(
        { image, err: error },
        'an image the configuration names could not be fetched ahead; the first sandbox to need it pulls again, and fails with the reason if it still cannot be had',
      );
    }
  }
}
