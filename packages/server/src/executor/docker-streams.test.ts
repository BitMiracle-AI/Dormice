import { PassThrough, Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CallbackSink,
  CappedBuffer,
  END_PROBE_MS,
  OutputDelivery,
  pumpMultiplexedStream,
  pumpRawStream,
  TAIL_LIMIT_BYTES,
} from './docker-streams';

/** One docker attach-protocol frame: type, three zeros, u32BE length, payload. */
function frame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('pumpMultiplexedStream', () => {
  it('reassembles frames split at arbitrary boundaries into the right sinks', async () => {
    const wire = Buffer.concat([
      frame(1, Buffer.from('hello ')),
      frame(2, Buffer.from('oops')),
      frame(1, Buffer.from('world')),
    ]);
    // One byte per chunk, deterministically: every header and every payload
    // straddles chunk boundaries (Readable.from yields each buffer as-is).
    const source = Readable.from(
      (function* () {
        for (let i = 0; i < wire.length; i++) yield wire.subarray(i, i + 1);
      })(),
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    await pumpMultiplexedStream(
      source,
      new CallbackSink((c) => {
        out.push(Buffer.from(c));
      }),
      new CallbackSink((c) => {
        err.push(Buffer.from(c));
      }),
    );
    expect(Buffer.concat(out).toString('utf8')).toBe('hello world');
    expect(Buffer.concat(err).toString('utf8')).toBe('oops');
  });

  it('resolves only after a slow sink took delivery of every byte', async () => {
    // The production truncation of 2026-08-08, minimized: the source ends
    // instantly (a fast in-container cat) while the consumer is still far
    // behind. Resolution must mean delivered — the count is taken AFTER the
    // consumer's own await, so an early resolve is caught red-handed.
    const source = new PassThrough();
    const frames = 48;
    const payload = Buffer.alloc(8 * 1024, 7);
    let received = 0;
    const pump = pumpMultiplexedStream(
      source,
      new CallbackSink(async (c) => {
        await sleep(1);
        received += c.length;
      }),
      new CallbackSink(() => {}),
    );
    for (let i = 0; i < frames; i++) source.write(frame(1, payload));
    source.end();
    await pump;
    expect(received).toBe(frames * payload.length);
  });

  it('a sink error rejects the pump and destroys the source stream', async () => {
    const source = new PassThrough();
    const pump = pumpMultiplexedStream(
      source,
      new CallbackSink(() => {
        throw new Error('client disconnected mid-download');
      }),
      new CallbackSink(() => {}),
    );
    source.write(frame(1, Buffer.from('doomed')));
    await expect(pump).rejects.toThrow('client disconnected mid-download');
    // The abort must travel back: a destroyed exec stream is what stops the
    // container from pouring a gigabyte into the void.
    expect(source.destroyed).toBe(true);
  });

  it('a source error rejects the pump', async () => {
    const source = new PassThrough();
    const pump = pumpMultiplexedStream(
      source,
      new CappedBuffer(1024),
      new CappedBuffer(1024),
    );
    source.destroy(new Error('exec stream reset'));
    await expect(pump).rejects.toThrow('exec stream reset');
  });

  it('zero-length frames and a trailing partial frame are dropped in silence', async () => {
    const source = new PassThrough();
    const stdout = new CappedBuffer(1024);
    const pump = pumpMultiplexedStream(source, stdout, new CappedBuffer(1024));
    source.write(frame(1, Buffer.alloc(0)));
    source.write(frame(1, Buffer.from('kept')));
    // A header promising 100 bytes, then the stream dies: stock demux drops
    // it too — the exit-code poll is what reports such a transport failure.
    source.write(frame(1, Buffer.alloc(100)).subarray(0, 12));
    source.end();
    await pump;
    expect(stdout.text()).toBe('kept');
  });
});

/**
 * A sink that takes each chunk only when the test says so — a reader far
 * behind, or stopped.
 */
function heldSink() {
  const reached: string[] = [];
  let take = () => {};
  const sink = new CallbackSink(async (chunk) => {
    reached.push(chunk.toString('utf8'));
    await new Promise<void>((resolve) => {
      take = resolve;
    });
  });
  return { sink, reached, take: () => take() };
}

describe('OutputDelivery', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads no further than the chunk its sink holds while the process runs, and the rest at once once it ended — handed over in order', async () => {
    vi.useFakeTimers();
    const source = new PassThrough();
    const { sink, reached, take } = heldSink();
    let asked = 0;
    let ended = false;
    const output = new OutputDelivery(async () => {
      asked += 1;
      return ended;
    });
    const pump = pumpMultiplexedStream(
      source,
      sink,
      new CappedBuffer(1024),
      output,
    );
    source.write(frame(1, Buffer.from('a')));
    await vi.advanceTimersByTimeAsync(1);
    source.write(frame(1, Buffer.from('b')));
    source.end(frame(1, Buffer.from('c')));
    await vi.advanceTimersByTimeAsync(4 * END_PROBE_MS);
    // Asked, and told the process runs: the reader sets the pace.
    expect(asked).toBeGreaterThan(0);
    expect(source.readableEnded).toBe(false);

    ended = true;
    await vi.advanceTimersByTimeAsync(END_PROBE_MS);
    // Read to the end — dockerd is rid of it — while the sink still holds 'a'.
    expect(source.readableEnded).toBe(true);
    expect(output.undelivered).toBe(true);
    for (let i = 0; i < 3; i++) {
      take();
      await vi.advanceTimersByTimeAsync(1);
    }
    await pump;
    expect(reached).toEqual(['a', 'b', 'c']);
    expect(output.undelivered).toBe(false);
  });

  it('a reader keeping up is never asked about', async () => {
    const asked = vi.fn(async () => false);
    const source = new PassThrough();
    const pump = pumpMultiplexedStream(
      source,
      new CallbackSink(() => {}),
      new CappedBuffer(1024),
      new OutputDelivery(asked),
    );
    for (let i = 0; i < 100; i++) source.write(frame(1, Buffer.from('x')));
    source.end();
    await pump;
    expect(asked).not.toHaveBeenCalled();
  });

  it(`gives up on a tail past TAIL_LIMIT_BYTES: a child still writing after the process ended`, async () => {
    vi.useFakeTimers();
    const source = new PassThrough();
    const pump = pumpMultiplexedStream(
      source,
      new CallbackSink(() => new Promise<void>(() => {})),
      new CappedBuffer(1024),
      new OutputDelivery(async () => true),
    );
    const outcome = expect(pump).rejects.toThrow(
      'kept coming after the process ended',
    );
    source.write(frame(1, Buffer.from('first')));
    await vi.advanceTimersByTimeAsync(END_PROBE_MS);
    const mib = Buffer.alloc(1024 * 1024);
    for (let i = 0; i <= TAIL_LIMIT_BYTES / mib.length; i++) {
      source.write(frame(1, mib));
    }
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(source.destroyed).toBe(true);
  });

  it('abort: nothing it still holds reaches a sink — the chunk already with one is its own', async () => {
    vi.useFakeTimers();
    const source = new PassThrough();
    const { sink, reached, take } = heldSink();
    const output = new OutputDelivery(async () => true);
    const pump = pumpMultiplexedStream(
      source,
      sink,
      new CappedBuffer(1024),
      output,
    );
    const outcome = expect(pump).rejects.toThrow('past the bound');
    source.write(frame(1, Buffer.from('a')));
    await vi.advanceTimersByTimeAsync(END_PROBE_MS);
    source.end(frame(1, Buffer.from('b')));
    await vi.advanceTimersByTimeAsync(1);
    output.abort(new Error('past the bound'));
    take();
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(reached).toEqual(['a']);
  });

  it('a sink failing on the tail rejects the pump', async () => {
    vi.useFakeTimers();
    const source = new PassThrough();
    let calls = 0;
    const pump = pumpMultiplexedStream(
      source,
      new CallbackSink(async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, 10 * END_PROBE_MS),
          );
        } else throw new Error('client disconnected mid-download');
      }),
      new CappedBuffer(1024),
      new OutputDelivery(async () => true),
    );
    const outcome = expect(pump).rejects.toThrow(
      'client disconnected mid-download',
    );
    source.write(frame(1, Buffer.from('a')));
    await vi.advanceTimersByTimeAsync(END_PROBE_MS);
    source.end(frame(1, Buffer.from('b')));
    await vi.advanceTimersByTimeAsync(10 * END_PROBE_MS);
    await outcome;
  });
});

describe('pumpRawStream', () => {
  it('delivers the raw byte stream in order, resolving after delivery', async () => {
    const source = new PassThrough();
    const seen: string[] = [];
    const pump = pumpRawStream(
      source,
      new CallbackSink(async (c) => {
        await sleep(1);
        seen.push(c.toString('utf8'));
      }),
    );
    source.write('a');
    source.write('b');
    source.end('c');
    await pump;
    expect(seen.join('')).toBe('abc');
  });
});
