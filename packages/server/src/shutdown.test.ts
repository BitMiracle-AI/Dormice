import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { closeWithGrace, trackConnections } from './shutdown';

/**
 * A server whose one route never answers — the shape of a native
 * execCommand mid-run or a proxied stream: an in-flight request Fastify's
 * close would wait on forever. Plain http here, not the app: what is
 * under test is the grace-then-cut arithmetic, not any route.
 */
function hangingServer() {
  const server = http.createServer((_req, _res) => {
    // Never responds; the socket stays in flight until someone destroys it.
  });
  const sockets = trackConnections(server);
  const app = {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  return { server, sockets, app };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

/**
 * Opens a request and resolves once the server has accepted the socket —
 * on the server's own 'connection' event, the one the inventory listens
 * to; the client's connect callback fires on a different socket and gives
 * no ordering.
 */
function openRequest(server: http.Server, port: number): Promise<net.Socket> {
  const accepted = new Promise<void>((resolve) =>
    server.once('connection', () => resolve()),
  );
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('GET /hang HTTP/1.1\r\nHost: x\r\n\r\n');
      accepted.then(() => resolve(socket));
    });
    socket.on('error', reject);
  });
}

describe('closeWithGrace', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it('cuts the sockets still open when the grace period ends, and close() then finishes', async () => {
    const { server, sockets, app } = hangingServer();
    const port = await listen(server);
    const client = await openRequest(server, port);
    cleanups.push(() => client.destroy());
    expect(sockets.size).toBe(1);

    const closed = new Promise<void>((resolve) =>
      client.once('close', resolve),
    );
    const started = Date.now();
    const cut = await closeWithGrace(app, sockets, 100);
    // Waited the grace, not a second longer; close() resolved because the
    // cut removed the one connection it was waiting for.
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1500);
    expect(cut).toBe(1);
    await closed;
    // The inventory prunes on the server socket's own 'close', one tick
    // after the destroy — the client's close above is the other end.
    await new Promise((resolve) => setImmediate(resolve));
    expect(sockets.size).toBe(0);
  });

  it('cuts nothing when everything drains before the grace ends', async () => {
    const { server, sockets, app } = hangingServer();
    await listen(server);
    // No connection at all: close() resolves at once, the timer never fires.
    const cut = await closeWithGrace(app, sockets, 5000);
    expect(cut).toBe(0);
  });

  it('tracks upgraded sockets too — the ones closeAllConnections would miss', async () => {
    // An upgrade handler that takes the socket and keeps it: Node removes
    // it from the server's own connection list at this point, which is why
    // the inventory is kept by hand (nodejs/node#53536).
    const server = http.createServer();
    server.on('upgrade', (_req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
    });
    const sockets = trackConnections(server);
    const port = await listen(server);
    const client = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write(
          'GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        );
        s.once('data', () => resolve(s));
      });
      s.on('error', reject);
    });
    cleanups.push(() => client.destroy());
    expect(sockets.size).toBe(1);

    const app = {
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
    const cut = await closeWithGrace(app, sockets, 100);
    expect(cut).toBe(1);
    await new Promise<void>((resolve) => client.once('close', resolve));
  });
});
