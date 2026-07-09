import type {
  ExecStreamHandle,
  ExecStreamOptions,
  Executor,
  PtySize,
} from '../executor/executor';

/**
 * The daemon-side process table behind the E2B process surface. E2B's
 * defining behavior — `background: true` is the same wire as a foreground
 * run, `disconnect()` never kills, `connect(pid)` reattaches — means a
 * process's lifetime must be decoupled from any HTTP response's. This table
 * is that decoupling: envd streams are just subscribers that come and go;
 * the process lives here until it exits, is signaled, or its sandbox dies.
 *
 * It lives in e2b/ and not beside the executor on purpose: the pid scheme,
 * "list shows only the living" and the no-replay rule are all E2B protocol
 * semantics. The native API has no process verbs; hoisting this early would
 * be abstraction ahead of need.
 *
 * Deliberately not persisted: a daemon restart empties the table — the
 * in-container processes it tracked become orphans that the in-container
 * timeout backstop or the sandbox's own death reap. Honest and documented,
 * and better than E2B, whose registry does not even survive pause/resume.
 */

/** The process config as the SDK sent it, echoed back verbatim by List. */
export interface WireProcessConfig {
  cmd: string;
  args: string[];
  envs: Record<string, string>;
  cwd?: string;
}

export type OutputChannel = 'stdout' | 'stderr' | 'pty';

export type ProcessEnd =
  | { kind: 'exit'; exitCode: number }
  | { kind: 'error'; message: string };

export interface ProcessSubscriber {
  /**
   * One output chunk. A returned promise is awaited before the next chunk
   * reaches ANY subscriber — slowest-subscriber backpressure, the Unix pipe
   * semantic, riding the executor's own callback contract. With zero
   * subscribers the broadcast resolves immediately: a background process
   * nobody watches drains and drops, it never wedges.
   */
  onOutput(channel: OutputChannel, chunk: Buffer): void | Promise<void>;
  /** The process's ending. Called exactly once, after the last onOutput. */
  onEnd(end: ProcessEnd): void;
}

export interface ProcessRecord {
  readonly pid: number;
  readonly sandboxId: string;
  readonly config: WireProcessConfig;
  /** Whether Start promised stdin — SendInput's gate. */
  readonly stdin: boolean;
  /** Present for PTY sessions; List shows them alongside plain commands. */
  readonly pty?: PtySize;
  readonly handle: ExecStreamHandle;
}

interface InternalRecord extends ProcessRecord {
  readonly subscribers: Set<ProcessSubscriber>;
}

export class ProcessTable {
  /** Synthetic, table-wide: the SDK only ever uses pids as opaque handles. */
  private nextPid = 1000;
  private readonly records = new Map<number, InternalRecord>();

  /**
   * Registers, subscribes and starts in one step, in that order: the
   * initial subscriber is in place before the exec begins, and the executor
   * guarantees no output before execStream resolves — together, the first
   * chunk cannot be lost. A start failure leaves no table entry behind and
   * rethrows as-is.
   *
   * The process's ending is hooked here: wait() settling — exit code or
   * error, including the container dying under it — broadcasts onEnd to
   * every subscriber and deletes the entry. That single finalize path is
   * why sandbox stop/destroy needs no table hook: the physics (container
   * death ends every exec) conducts the cleanup.
   */
  async start(args: {
    executor: Executor;
    sandboxId: string;
    options: Omit<ExecStreamOptions, 'onStdout' | 'onStderr'>;
    config: WireProcessConfig;
    pty?: PtySize;
    subscriber?: ProcessSubscriber;
  }): Promise<ProcessRecord> {
    const pid = this.nextPid++;
    const subscribers = new Set<ProcessSubscriber>();
    if (args.subscriber) subscribers.add(args.subscriber);
    const broadcast =
      (channel: OutputChannel) =>
      (chunk: Buffer): Promise<void> =>
        Promise.all(
          [...subscribers].map((s) => s.onOutput(channel, chunk)),
        ).then(() => {});
    const handle = await args.executor.execStream(args.sandboxId, {
      ...args.options,
      // A PTY is one merged byte stream; a plain command keeps its two.
      onStdout: broadcast(args.pty ? 'pty' : 'stdout'),
      onStderr: broadcast('stderr'),
    });
    const record: InternalRecord = {
      pid,
      sandboxId: args.sandboxId,
      config: args.config,
      stdin: args.options.stdin ?? false,
      pty: args.pty,
      handle,
      subscribers,
    };
    this.records.set(pid, record);
    handle.wait().then(
      ({ exitCode }) => this.finalize(record, { kind: 'exit', exitCode }),
      (error) =>
        this.finalize(record, {
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
    );
    return record;
  }

  /** Living processes only; a pid from another sandbox is invisible. */
  get(sandboxId: string, pid: number): ProcessRecord | undefined {
    const record = this.records.get(pid);
    return record?.sandboxId === sandboxId ? record : undefined;
  }

  list(sandboxId: string): ProcessRecord[] {
    return [...this.records.values()].filter((r) => r.sandboxId === sandboxId);
  }

  /**
   * Attaches a subscriber; returns the unsubscribe, or undefined when the
   * process already ended (finalize won between the caller's get and this
   * call) — the caller reports not_found instead of waiting on a stream
   * that would never end. No replay: a late subscriber sees output from
   * now on, same as real envd.
   */
  subscribe(
    pid: number,
    subscriber: ProcessSubscriber,
  ): (() => void) | undefined {
    const record = this.records.get(pid);
    if (!record) return undefined;
    record.subscribers.add(subscriber);
    return () => record.subscribers.delete(subscriber);
  }

  /** Detaches a subscriber start() attached; gone-already is the goal state. */
  unsubscribe(pid: number, subscriber: ProcessSubscriber): void {
    this.records.get(pid)?.subscribers.delete(subscriber);
  }

  private finalize(record: InternalRecord, end: ProcessEnd): void {
    if (!this.records.delete(record.pid)) return;
    for (const subscriber of [...record.subscribers]) {
      record.subscribers.delete(subscriber);
      try {
        subscriber.onEnd(end);
      } catch {
        // A subscriber whose stream already broke is its own ending.
      }
    }
  }
}
