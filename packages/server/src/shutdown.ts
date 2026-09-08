import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * Every live socket the server has accepted, upgraded ones included. Kept
 * by hand because the platform's own bookkeeping stops short of what a
 * shutdown needs: http.Server#closeAllConnections destroys only the sockets
 * still on the server's request/response list — a socket handed to an
 * 'upgrade' listener (the sandbox proxy's WebSockets) leaves that list and
 * is never destroyed by it (nodejs/node#53536). A Set of the 'connection'
 * event's sockets, pruned on 'close', is the honest inventory.
 */
export function trackConnections(server: Server): Set<Duplex> {
  const sockets = new Set<Duplex>();
  server.on('connection', (socket: Duplex) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return sockets;
}

/**
 * Closes the app and gives in-flight work a bounded grace period, then
 * cuts whatever is still connected so close() can finish.
 *
 * What close() alone does: stops the listener (new connections are refused
 * from this instant), ends the long-lived streams through preClose, closes
 * idle keep-alives — and then waits for every request still in flight.
 * Most finish in milliseconds; a native execCommand may legitimately run
 * for hours, a proxied SSE or WebSocket for days. Waiting for those means
 * waiting for systemd's SIGKILL (90s by default) with the door already
 * shut the whole time: every acquire in that window is refused for
 * nothing, and the streams die anyway, with no more warning than a reset.
 * Measured on two production hosts 2026-09-08: the stop ran the full 90s
 * into SIGKILL and the consumer logged the whole window as user-visible
 * "execution interrupted".
 *
 * So the grace is for the short work — a write landing, a cold start
 * finishing, a freeze's memory.reclaim — and the long streams are cut at
 * its end: the client sees a closed connection a few seconds sooner than
 * it would have, and the daemon is back that much earlier. Crash-only
 * makes the cut safe: reality moves before the ledger records it, so an
 * interrupted step is a plain drift the next boot's reconcile repairs.
 *
 * Returns how many sockets had to be cut (0 = everything drained in time),
 * for the caller's log line.
 */
export async function closeWithGrace(
  app: { close(): Promise<unknown> },
  sockets: Set<Duplex>,
  graceMs: number,
): Promise<number> {
  let cut = 0;
  const grace = setTimeout(() => {
    for (const socket of sockets) {
      socket.destroy();
      cut += 1;
    }
  }, graceMs);
  try {
    await app.close();
  } finally {
    clearTimeout(grace);
  }
  return cut;
}
