import { Writable } from 'node:stream';

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
 * awaited before the next chunk is accepted: that is how a slow consumer's
 * backpressure travels through demux all the way to the in-container writer.
 */
export class CallbackSink extends Writable {
  constructor(
    private readonly onChunk: (chunk: Buffer) => void | Promise<void>,
  ) {
    super();
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
