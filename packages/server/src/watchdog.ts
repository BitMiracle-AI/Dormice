/**
 * The heartbeat's dead-man switch.
 *
 * Why it exists (2026-08-13, Beijing production): the heartbeat is a chain —
 * each tick schedules the next only after it finishes — so a single await
 * that never settles kills reconciliation and idle cooling forever, with no
 * error to catch: try/catch hears failures, not silence. The daemon looked
 * healthy the whole time (the metrics sampler ticks on its own timer) while
 * zero freezes happened for eleven hours and 643 sandboxes piled up active.
 * Per-call deadlines (executor/deadline.ts) bound every await we know
 * about; the watchdog bounds the ones we don't.
 *
 * It watches progress, not tick duration: a backlog sweep that freezes
 * hundreds of sandboxes legitimately runs for a long time but beats on
 * every row — and an archive transfer pulses on real bytes moving — while
 * a stuck tick beats on none. The stall limit therefore only needs to
 * exceed the longest single *silent* step (a docker verb, itself
 * deadline-bounded), not the longest sweep or transfer.
 *
 * On stall it bites once and stops checking: the intended reaction is a
 * crash-only exit — systemd restarts the daemon in seconds, startup
 * reconciliation squares the ledger with reality, and the ledger already
 * holds every row the stuck sweep completed. A watchdog that keeps barking
 * after biting is noise.
 *
 * Honest limitation: the checker shares the event loop it guards. A stalled
 * await leaves the loop idle and the checker fires; a *seized* loop (sync
 * code spinning) blocks the checker too — that failure mode needs an
 * out-of-process monitor and is out of scope here.
 */
export class Watchdog {
  private readonly stallAfterMs: number;
  private readonly checkEveryMs: number;
  private readonly onStall: (stalledForMs: number) => void;
  private readonly now: () => number;
  private lastBeat: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: {
    /** How long without a beat() counts as stalled. */
    stallAfterMs: number;
    /** How often to look at the clock. */
    checkEveryMs: number;
    /** The bite. Called exactly once; checking stops afterwards. */
    onStall: (stalledForMs: number) => void;
    /** Injected clock for tests. */
    now?: () => number;
  }) {
    this.stallAfterMs = opts.stallAfterMs;
    this.checkEveryMs = opts.checkEveryMs;
    this.onStall = opts.onStall;
    this.now = opts.now ?? Date.now;
    this.lastBeat = this.now();
  }

  /** Progress happened. Cheap enough to call once per scanned row. */
  beat(): void {
    this.lastBeat = this.now();
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.lastBeat = this.now();
    this.timer = setInterval(() => {
      const stalledFor = this.now() - this.lastBeat;
      if (stalledFor >= this.stallAfterMs) {
        this.stop();
        this.onStall(stalledFor);
      }
    }, this.checkEveryMs);
    // The watchdog must never be what keeps the process alive.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
