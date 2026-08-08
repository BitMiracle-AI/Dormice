import { PassThrough, Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  CallbackSink,
  CappedBuffer,
  pumpMultiplexedStream,
  pumpRawStream,
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
