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
 * Demultiplexes a docker exec stream (Tty off) into its stdout/stderr sinks
 * — the replacement for docker-modem's demuxStream, which writes to the
 * sinks in flowing mode and ignores write()'s return value: no backpressure,
 * and with a slow consumer the whole output piles up in the sink's internal
 * buffer. That buffering, combined with completion signaled off the raw
 * stream's 'end', silently truncated large file downloads (measured on the
 * Beijing production face, 2026-08-08: a fast in-container cat ends the raw
 * stream while megabytes still sit undelivered; the response was then
 * finished under them). This pump reads pull-based and awaits each frame's
 * delivery, so its resolution is the true completion signal — and a slow
 * consumer holds the exec stream itself, bounding daemon memory to one frame.
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
): Promise<void> {
  let pending: Buffer = Buffer.alloc(0);
  for await (const data of stream as AsyncIterable<Buffer>) {
    pending = pending.length === 0 ? data : Buffer.concat([pending, data]);
    while (pending.length >= 8) {
      const size = pending.readUInt32BE(4);
      if (pending.length < 8 + size) break;
      const type = pending[0];
      const payload = pending.subarray(8, 8 + size);
      pending = pending.subarray(8 + size);
      if (size === 0) continue;
      await deliver(type === 2 ? stderr : stdout, payload);
    }
  }
}

/**
 * The PTY twin: a Tty-on exec is one merged raw byte stream, nothing to
 * demux — but the same delivery-before-resolution promise holds, replacing
 * a bare pipe() whose completion nobody could observe.
 */
export async function pumpRawStream(
  stream: Readable,
  sink: Writable,
): Promise<void> {
  for await (const data of stream as AsyncIterable<Buffer>) {
    await deliver(sink, data);
  }
}
