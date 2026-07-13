import type http from 'node:http';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { Config } from './config';
import type { Db } from './db/db';
import { findBySandboxId, touch } from './db/ledger';
import type { SandboxRow } from './db/schema';
import { e2bView } from './e2b/view';
import { startExecHeartbeat } from './exec-heartbeat';
import type { Executor } from './executor/executor';
import type { KeyedQueue } from './keyed-queue';
import { wakeSandbox } from './lifecycle';

/**
 * The sandbox port proxy: the server half of E2B's getHost(). A request
 * whose Host header reads `<port>-<sandboxId>.<domain>` is dialed straight
 * into that sandbox's port; a frozen sandbox wakes on traffic first — the
 * autoResume semantics, and the product thesis (idle is free, waking is
 * 50ms) applied to web traffic.
 *
 * The daemon still binds 127.0.0.1 only: public TLS and wildcard DNS are
 * the operator's reverse proxy's job (Caddy with `flush_interval -1`,
 * measured on the predecessor system — without it streaming responses
 * buffer into one lump).
 *
 * Sandbox traffic is deliberately unauthenticated, like E2B's: a preview
 * URL exists to be opened by whoever it is shared with. What the proxy
 * reaches is only ever the sandbox's own ports.
 */

/**
 * Host header -> { port, sandboxId }, or null when it is not sandbox
 * traffic (then the request belongs to Fastify). The port suffix of the
 * header itself (`:3676`) is not the sandbox port — the label carries that.
 */
export function parseSandboxHost(
  hostHeader: string | undefined,
  domain: string,
): { port: number; sandboxId: string } | null {
  if (!hostHeader) return null;
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
  const suffix = `.${domain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  const match = label.match(
    /^(\d{1,5})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  );
  if (!match) return null;
  const port = Number(match[1]);
  if (port < 1 || port > 65535) return null;
  return { port, sandboxId: match[2] as string };
}

export interface SandboxProxyDeps {
  config: Config;
  db: Db;
  executor: Executor;
  locks: KeyedQueue;
}

export interface SandboxProxy {
  /** Is this request sandbox traffic? Cheap: a Host header parse. */
  matches(req: http.IncomingMessage): boolean;
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void;
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void;
}

class ProxyRefusal extends Error {}

export function createSandboxProxy(deps: SandboxProxyDeps): SandboxProxy {
  const { config, db, executor, locks } = deps;
  const domain = config.DORMICE_SANDBOX_DOMAIN ?? '';

  function liveRow(sandboxId: string): SandboxRow {
    const row = findBySandboxId(db, sandboxId);
    if (!row || e2bView(row, new Date()) !== 'running') {
      throw new ProxyRefusal(
        !row || e2bView(row, new Date()) === 'dead'
          ? `sandbox ${sandboxId} not found`
          : `sandbox ${sandboxId} is paused`,
      );
    }
    return row;
  }

  /**
   * Host -> a dialable target, waking the sandbox under its key slot like
   * every other verb (physical wake-ups must not race the scanner or a
   * destroy). Throws ProxyRefusal for everything that deserves a 502.
   */
  async function resolveTarget(req: http.IncomingMessage): Promise<{
    row: SandboxRow;
    port: number;
    target: { host: string; port: number };
  }> {
    const parsed = parseSandboxHost(req.headers.host, domain);
    if (!parsed) throw new ProxyRefusal('not sandbox traffic');
    const before = liveRow(parsed.sandboxId);
    const row = await locks.run(before.externalId, async () => {
      const fresh = liveRow(parsed.sandboxId);
      const awake = await wakeSandbox(db, executor, fresh);
      return touch(db, awake.sandboxId);
    });
    const target = await executor.resolvePortTarget(row.sandboxId, parsed.port);
    return { row, port: parsed.port, target };
  }

  function refuse(res: http.ServerResponse, message: string): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = JSON.stringify({ message });
    res.writeHead(502, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    });
    res.end(body);
  }

  return {
    matches(req) {
      return parseSandboxHost(req.headers.host, domain) !== null;
    },

    handleRequest(req, res) {
      void (async () => {
        let resolved: Awaited<ReturnType<typeof resolveTarget>>;
        try {
          resolved = await resolveTarget(req);
        } catch (error) {
          refuse(
            res,
            error instanceof ProxyRefusal
              ? error.message
              : 'sandbox proxy failed',
          );
          return;
        }
        const { row, port, target } = resolved;
        // A proxied connection is activity: warmth lives exactly as long
        // as the connection, then the idle countdown restarts.
        const stopHeartbeat = startExecHeartbeat(
          db,
          row.sandboxId,
          row.freezeAfterSeconds,
        );
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          stopHeartbeat();
          try {
            touch(db, row.sandboxId);
          } catch {
            // Released mid-request; the connection's ending tells the story.
          }
        };
        // Host travels unrewritten — a transparent proxy, like E2B's edge;
        // upstream servers with host allowlists (vite) configure their own.
        const upstream = httpRequest({
          host: target.host,
          port: target.port,
          method: req.method,
          path: req.url,
          headers: req.headers,
        });
        req.pipe(upstream);
        upstream.on('response', (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        });
        upstream.on('error', () => {
          settle();
          refuse(
            res,
            `sandbox ${row.sandboxId} is not listening on port ${port}`,
          );
        });
        res.on('close', () => {
          settle();
          upstream.destroy();
        });
      })();
    },

    handleUpgrade(req, socket, head) {
      void (async () => {
        let resolved: Awaited<ReturnType<typeof resolveTarget>>;
        try {
          resolved = await resolveTarget(req);
        } catch (error) {
          const message =
            error instanceof ProxyRefusal
              ? error.message
              : 'sandbox proxy failed';
          socket.end(
            `HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify({ message })}`,
          );
          return;
        }
        const { row, target } = resolved;
        const stopHeartbeat = startExecHeartbeat(
          db,
          row.sandboxId,
          row.freezeAfterSeconds,
        );
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          stopHeartbeat();
          try {
            touch(db, row.sandboxId);
          } catch {
            // Released mid-connection.
          }
        };
        const upstream = net.connect(target.port, target.host, () => {
          // Replay the upgrade request verbatim — rawHeaders keeps the
          // original casing and repetition the handshake may care about.
          let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
          }
          upstream.write(`${raw}\r\n`);
          if (head.length > 0) upstream.write(head);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        upstream.on('error', () => {
          settle();
          socket.destroy();
        });
        socket.on('error', () => {
          settle();
          upstream.destroy();
        });
        socket.on('close', () => {
          settle();
          upstream.destroy();
        });
        upstream.on('close', () => {
          settle();
          socket.destroy();
        });
      })();
    },
  };
}
