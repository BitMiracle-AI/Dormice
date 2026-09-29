import { EventEmitter } from 'node:events';
import http, { type ServerResponse } from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_STALL_SECONDS, writeToClient } from './shared';

/**
 * A response stand-in: write() answers as told, destroy() flips .destroyed
 * at once and emits 'close' a tick later — Node's own order, the one the
 * "attached after the fact" guard exists for.
 */
function stubResponse(writeReturns: boolean) {
  const res = new EventEmitter() as EventEmitter & {
    destroyed: boolean;
    write: (chunk: Buffer) => boolean;
    destroy: () => void;
  };
  res.destroyed = false;
  res.write = () => writeReturns;
  res.destroy = vi.fn(() => {
    res.destroyed = true;
    setImmediate(() => res.emit('close'));
  });
  return res;
}

const chunk = Buffer.from('frame');

afterEach(() => {
  vi.useRealTimers();
});

describe('writeToClient', () => {
  it('a chunk the socket takes at once is taken', async () => {
    const res = stubResponse(true);
    await expect(
      writeToClient(res as unknown as ServerResponse, chunk),
    ).resolves.toBe('taken');
  });

  it('a response already destroyed is gone, nothing written', async () => {
    const res = stubResponse(true);
    res.destroyed = true;
    await expect(
      writeToClient(res as unknown as ServerResponse, chunk),
    ).resolves.toBe('gone');
  });

  it('under backpressure, a drain takes it and a close makes it gone', async () => {
    const drained = stubResponse(false);
    const taken = writeToClient(drained as unknown as ServerResponse, chunk);
    drained.emit('drain');
    await expect(taken).resolves.toBe('taken');

    const closed = stubResponse(false);
    const gone = writeToClient(closed as unknown as ServerResponse, chunk);
    closed.emit('close');
    await expect(gone).resolves.toBe('gone');
  });

  it('a client that takes nothing for the stall bound is stalled and let go', async () => {
    vi.useFakeTimers();
    const res = stubResponse(false);
    const outcome = writeToClient(res as unknown as ServerResponse, chunk);
    await vi.advanceTimersByTimeAsync(CLIENT_STALL_SECONDS * 1000 - 1);
    expect(res.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe('stalled');
    expect(res.destroy).toHaveBeenCalledTimes(1);
  });

  it('progress restarts the clock: a drain before the bound is taken, not stalled', async () => {
    vi.useFakeTimers();
    const res = stubResponse(false);
    const outcome = writeToClient(res as unknown as ServerResponse, chunk);
    await vi.advanceTimersByTimeAsync(CLIENT_STALL_SECONDS * 1000 - 1);
    res.emit('drain');
    await expect(outcome).resolves.toBe('taken');
    await vi.advanceTimersByTimeAsync(CLIENT_STALL_SECONDS * 1000);
    expect(res.destroy).not.toHaveBeenCalled();
  });

  it('over a real socket: a client that connects, asks and never reads is let go', async () => {
    // The Beijing shape, minimized: the peer is alive and its window is at
    // zero, so 'drain' never fires and 'close' never comes on its own.
    let served: Promise<'taken' | 'gone' | 'stalled'> | undefined;
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      served = (async () => {
        const big = Buffer.alloc(64 * 1024, 7);
        for (;;) {
          const outcome = await writeToClient(res, big, 200);
          if (outcome !== 'taken') return outcome;
        }
      })();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as net.AddressInfo;
    const client = net.connect(port, '127.0.0.1');
    client.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    client.pause();
    try {
      await vi.waitFor(() => expect(served).toBeDefined());
      await expect(served).resolves.toBe('stalled');
    } finally {
      client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
