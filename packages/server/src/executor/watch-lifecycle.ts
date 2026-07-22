interface WatchExit {
  exitCode: number;
  error: Error | undefined;
}

interface WatchProcessLifecycleOptions {
  exit: Promise<WatchExit>;
  stopProcess(): Promise<void>;
  /** True only while another stop attempt can still reach the process. */
  canRetryStop(): Promise<boolean>;
  onNaturalEnd(outcome: WatchExit): void;
}

/**
 * Arbitrates one physical watcher process between natural exit and explicit
 * stop. Marking `stopping` before signaling is the identity point: an exit in
 * that window belongs to stop(), not onNaturalEnd. A failed signal hands that
 * identity back only while the process is still reachable for a later retry.
 */
export class WatchProcessLifecycle {
  private state: 'running' | 'stopping' | 'stopped' = 'running';
  private exited = false;
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly opts: WatchProcessLifecycleOptions) {
    void opts.exit.then((outcome) => {
      this.exited = true;
      if (this.state !== 'running') {
        this.state = 'stopped';
        return;
      }
      this.state = 'stopped';
      opts.onNaturalEnd(outcome);
    });
  }

  get delivering(): boolean {
    return this.state === 'running';
  }

  stop(): Promise<void> {
    if (this.state === 'stopped') return Promise.resolve();
    if (this.stopPromise) return this.stopPromise;

    this.state = 'stopping';
    const attempt = this.stopOnce();
    this.stopPromise = attempt;
    void attempt.then(
      () => {
        if (this.stopPromise === attempt) this.stopPromise = undefined;
      },
      () => {
        if (this.stopPromise === attempt) this.stopPromise = undefined;
      },
    );
    return attempt;
  }

  private async stopOnce(): Promise<void> {
    if (this.exited) return;
    try {
      await this.opts.stopProcess();
    } catch (error) {
      const canRetry = this.exited ? false : await this.opts.canRetryStop();
      if (this.exited || !canRetry) {
        this.state = 'stopped';
        return;
      }
      this.state = 'running';
      throw error;
    }
    await this.opts.exit;
    this.state = 'stopped';
  }
}
