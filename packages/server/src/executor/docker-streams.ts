import { type Readable, Writable } from 'node:stream';

/**
 * A Writable that keeps the first `cap` bytes and drains the rest. Draining
 * is the point: if the sink stopped acknowledging chunks past the cap,
 * backpressure would wedge the exec stream and the command with it.
 */
export class CappedBuffer extends Writable {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly cap: number) {
    super();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: () => void,
  ): void {
    const room = this.cap - this.size;
    if (room > 0) {
      const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
      this.chunks.push(kept);
      this.size += kept.length;
    }
    if (chunk.length > room) this.truncated = true;
    callback();
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }

  text(): string {
    return this.bytes().toString('utf8');
  }
}

/**
 * A Writable that hands each chunk to a callback — the streaming sink for
 * exec output and file downloads. When the callback returns a promise it is
 * awaited before the next chunk is accepted; the pumps below deliver one
 * chunk at a time, so that await IS the backpressure, all the way to the
 * in-container writer.
 *
 * The callback may wait on a client taking bytes — bounded where the daemon
 * waits on one (writeToClient in e2b/envd/shared.ts) — and never on
 * something that itself waits for this stream's later output: that never
 * returns (docker.ts watchDir has the case). How long a reader takes is its
 * own business while the exec's process runs; once the process has ended,
 * the pump no longer waits on it (OutputDelivery).
 */
export class CallbackSink extends Writable {
  constructor(
    private readonly onChunk: (chunk: Buffer) => void | Promise<void>,
  ) {
    super();
    // A throwing onChunk (a download whose client hung up) reports through
    // _write's callback — which the pumps' deliver() receives — but Node
    // ALSO emits it as an 'error' event; unlistened, that emit would crash
    // the daemon. The write callback is this sink's one error channel.
    this.on('error', () => {});
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    Promise.resolve()
      .then(() => this.onChunk(chunk))
      .then(
        () => callback(),
        (err) => callback(err instanceof Error ? err : new Error(String(err))),
      );
  }
}

/**
 * One chunk, delivered: write() with a callback fires only after the sink's
 * _write completed — for CallbackSink, after the consumer's promise settled.
 * Awaiting it before reading on is what makes the pumps below lossless: when
 * a pump's promise resolves, every byte has been HANDED OVER, not merely
 * queued in a Writable's internal buffer.
 */
function deliver(sink: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * How long a chunk may sit with its sink before the pump asks whether the
 * exec's process has ended — and again as often while it keeps sitting.
 * A reader keeping up is never asked about.
 */
export const END_PROBE_MS = 5000;

/**
 * The most output the pump keeps for its sinks once the exec's process has
 * ended. What dockerd still holds of a finished process is its pipe and its
 * own buffer: about two megabytes when dockerd recorded the exit of a `cat`
 * whose reader was far behind (measured 2026-09-30). More than this is a
 * child of the process still writing into the exec's stdout after the
 * process itself ended — given up on, never kept.
 */
export const TAIL_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * One exec's output on its way to its sinks, in order. While the exec's
 * process runs, one chunk at a time: the pump reads on only once the sink
 * took the last one, so a slow reader sets the process's pace (the pipe
 * semantic) and daemon memory stays at one chunk. Once the process has
 * ended, the rest is read at once and handed over from memory at the
 * sink's pace. The rest is then only what dockerd still holds, and dockerd
 * cannot finish the exec until it is rid of it: its handling of the exit
 * closes the exec's output under a lock its copy of that output holds while
 * the output waits to be read — and it handles one container's events one
 * at a time, so an unread tail parks every later exec of the container
 * (moby #53614, open as of Docker 29.8; Beijing, 2026-09-28: three
 * sandboxes frozen, one for 36 hours, each behind a download whose client
 * had stopped reading).
 *
 * `ended` says whether the process has ended, and is asked about a chunk
 * that has sat with its sink for END_PROBE_MS, then every END_PROBE_MS
 * while it sits. A tail of ours thus holds dockerd for two such periods
 * plus that answer at most — 40s when dockerd cannot answer (docker.ts
 * execEnded) — inside the shortest wait for an exec's end, a file
 * operation's 60s plus EXEC_END_GRACE_SECONDS: the container's other execs
 * are delayed, never failed.
 */
export class OutputDelivery {
  /** The last delivery handed out; each waits for the one before it. */
  private last: Promise<void> = Promise.resolve();
  /** Bytes handed over and not yet taken by their sink. */
  private held = 0;
  /** When the chunk now with its sink got there (ms); 0 while none is. */
  private since = 0;
  private failure: Error | undefined;
  private draining = false;
  private asking = false;
  private timer: NodeJS.Timeout | undefined;
  private release = () => {};
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  constructor(private readonly ended?: () => Promise<boolean>) {}

  /** Whether output is still on its way to a sink. */
  get undelivered(): boolean {
    return this.held > 0;
  }

  /**
   * Hands one chunk to its sink, after every chunk handed before it, and
   * resolves when the pump may read on: once the chunk is taken while the
   * process runs, at once after it ended.
   */
  async hand(sink: Writable, chunk: Buffer): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.draining && this.held + chunk.length > TAIL_LIMIT_BYTES) {
      throw this.fail(
        new Error(
          `more than ${TAIL_LIMIT_BYTES} bytes of output kept coming after the process ended — a child of it still writing; the rest is not kept`,
        ),
      );
    }
    this.held += chunk.length;
    const delivery = this.last.then(async () => {
      try {
        if (this.failure) return;
        this.since = Date.now();
        await deliver(sink, chunk);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.since = 0;
        this.held -= chunk.length;
      }
    });
    this.last = delivery;
    if (this.draining) return;
    this.watch();
    await Promise.race([delivery, this.released]);
    if (this.failure) throw this.failure;
  }

  /** Every chunk handed over taken by its sink, or the first failure. */
  async finish(): Promise<void> {
    await this.last;
    this.unwatch();
    if (this.failure) throw this.failure;
  }

  /** Nothing more reaches a sink; the chunk already with one is its own. */
  abort(error: Error): void {
    this.fail(error);
    this.unwatch();
    this.release();
  }

  private fail(error: Error): Error {
    this.failure ??= error;
    return this.failure;
  }

  private watch(): void {
    if (this.ended === undefined || this.timer !== undefined) return;
    this.timer = setInterval(() => void this.ask(), END_PROBE_MS);
    // A watch on the reader, never a reason for the daemon to stay up.
    this.timer.unref();
  }

  private unwatch(): void {
    clearInterval(this.timer);
  }

  private async ask(): Promise<void> {
    const ended = this.ended;
    if (
      ended === undefined ||
      this.asking ||
      this.since === 0 ||
      Date.now() - this.since < END_PROBE_MS
    ) {
      return;
    }
    this.asking = true;
    try {
      if (await ended()) {
        this.draining = true;
        this.unwatch();
        this.release();
      }
    } catch {
      // Not known to have ended: the reader keeps setting the pace.
    } finally {
      this.asking = false;
    }
  }
}

/**
 * Demultiplexes a docker exec stream (Tty off) into its stdout/stderr sinks
 * — the replacement for docker-modem's demuxStream, which writes to the
 * sinks in flowing mode and ignores write()'s return value: no backpressure,
 * and with a slow consumer the whole output piles up in the sink's internal
 * buffer. That buffering, combined with completion signaled off the raw
 * stream's 'end', silently truncated large file downloads (measured on the
 * Beijing production face, 2026-08-08: a fast in-container cat ends the raw
 * stream while megabytes still sit undelivered; the response was then
 * finished under them). This pump reads pull-based and hands each frame to
 * `output`, which paces the reading (OutputDelivery), so its resolution is
 * the true completion signal.
 *
 * Frame grammar (Docker's attach protocol): 8-byte header — stream type,
 * three zeros, payload length u32BE — then the payload. A frame can span
 * socket chunks and a chunk can carry many frames. Type 2 is stderr,
 * everything else lands on stdout (1 = stdout; 0 = stdin echo, never sent
 * for our execs). A trailing partial frame at stream end is dropped, as
 * stock demux drops it — the exit-code poll that follows is what reports
 * such a transport failure.
 *
 * Aborting: a sink error (a download whose client vanished) rejects the
 * pump; throwing out of for-await destroys the underlying exec stream, so
 * the transfer stops instead of draining into the void.
 */
export async function pumpMultiplexedStream(
  stream: Readable,
  stdout: Writable,
  stderr: Writable,
  output = new OutputDelivery(),
): Promise<void> {
  let pending: Buffer = Buffer.alloc(0);
  try {
    for await (const data of stream as AsyncIterable<Buffer>) {
      pending = pending.length === 0 ? data : Buffer.concat([pending, data]);
      while (pending.length >= 8) {
        const size = pending.readUInt32BE(4);
        if (pending.length < 8 + size) break;
        const type = pending[0];
        const payload = pending.subarray(8, 8 + size);
        pending = pending.subarray(8 + size);
        if (size === 0) continue;
        await output.hand(type === 2 ? stderr : stdout, payload);
      }
    }
  } catch (error) {
    output.abort(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  await output.finish();
}

/**
 * The PTY twin: a Tty-on exec is one merged raw byte stream, nothing to
 * demux — but the same delivery-before-resolution promise holds, replacing
 * a bare pipe() whose completion nobody could observe.
 */
export async function pumpRawStream(
  stream: Readable,
  sink: Writable,
  output = new OutputDelivery(),
): Promise<void> {
  try {
    for await (const data of stream as AsyncIterable<Buffer>) {
      await output.hand(sink, data);
    }
  } catch (error) {
    output.abort(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  await output.finish();
}
