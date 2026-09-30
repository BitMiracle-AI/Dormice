interface WatchExit {
  exitCode: number;
  error: Error | undefined;
}

export type FailedStopDisposition = 'retry' | 'terminal';

interface WatchProcessLifecycleOptions {
  exit: Promise<WatchExit>;
  stopProcess(): Promise<void>;
  classifyFailedStop(): Promise<FailedStopDisposition>;
  onNaturalEnd(outcome: WatchExit): void;
}

/**
 * Arbitrates one physical watcher process between natural exit and explicit
 * stop. Marking `stopping` before signaling is the identity point: an exit in
 * that window belongs to stop(), not onNaturalEnd. A failed signal hands that
 * identity back only while the process is still reachable for a later retry.
 *
 * A delivered SIGKILL is the end: stop() settles on it, not on dockerd's
 * report of the exit. The report can be lost for good (EXEC_END_GRACE_SECONDS
 * in @dormice/shared has why), and stop() runs inside a sandbox's slot — the
 * wake reaps retired watchers — where waiting on it held the slot forever.
 * Nothing needs the report: events and onEnd are already suppressed from
 * the moment stop() began.
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
    } catch (signalError) {
      let disposition: FailedStopDisposition;
      try {
        disposition = this.exited
          ? 'terminal'
          : await this.opts.classifyFailedStop();
      } catch (inspectError) {
        if (this.exited) {
          this.state = 'stopped';
          return;
        }
        this.state = 'running';
        throw new AggregateError(
          [signalError, inspectError],
          'watcher stop failed and container state is unknown',
        );
      }
      if (this.exited || disposition === 'terminal') {
        this.state = 'stopped';
        return;
      }
      this.state = 'running';
      throw signalError;
    }
    this.state = 'stopped';
  }
}
