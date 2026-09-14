import {
  type BuildInfo,
  type CheckInRequest,
  checkInResponseSchema,
  type NodeReading,
} from '@dormice/shared';
import type { Db } from './db/db';
import { countByState, listSandboxes } from './db/ledger';
import { type CpuSampler, readHostReading } from './host-metrics';

/**
 * A node's reading for its check-in: the host half (host-metrics.ts) and
 * the ledger's census. The same numbers getHostMetrics answers a caller
 * with, minus the daemon-local knobs no gateway places by.
 */
export async function readNodeReading(
  db: Db,
  cpu: CpuSampler,
  dataDir: string,
): Promise<NodeReading> {
  const { byState, total } = countByState(listSandboxes(db));
  return {
    ...(await readHostReading(cpu, dataDir)),
    sandboxes: { total, byState },
  };
}

export interface CheckInLog {
  info(msg: string): void;
  warn(obj: unknown, msg: string): void;
}

export interface CheckInOptions {
  /** DORMICE_GATEWAY_ENDPOINT. */
  gateway: string;
  /** The token gateway and nodes share (DORMICE_API_TOKEN). */
  token: string;
  nodeId: string;
  /** Where the gateway reaches this node (DORMICE_NODE_ENDPOINT or the loopback default). */
  endpoint: string;
  intervalSeconds: number;
  build: BuildInfo | null;
  readReading: () => Promise<NodeReading>;
  log: CheckInLog;
  /** Test seam; production uses the platform's fetch. */
  fetchImpl?: typeof fetch;
}

/** A gateway that has not answered within this is a gateway not answering; the next tick tries again. */
const CHECK_IN_TIMEOUT_MS = 10_000;

/**
 * The node's check-in ticker: every interval, one POST /checkIn to the
 * gateway carrying the node's id, where it can be reached, its build and
 * a fresh reading (RULES/协议.md「网关」). The gateway learns of a node from
 * its first check-in — no registration verb, no nodes file — and reads
 * two missed check-ins as down.
 *
 * Chained setTimeout, the daemon's discipline: the next tick is scheduled
 * when this one is done, so a slow gateway never has ticks pile up.
 * Failures are logged on the change — once when the gateway stops
 * answering, once more when what is wrong changes (a gateway that was
 * unreachable and now refuses this node is news), once when it answers
 * again — never every tick: a gateway down for an hour is one event, not
 * two hundred and forty lines. Never fatal: the gateway is the fleet's
 * front door and configuration authority, not the node's reason to live;
 * the node keeps running its sandboxes and keeps trying.
 */
/**
 * A failure in the operator's words. fetch says "fetch failed" and keeps
 * the reason (ECONNREFUSED, ENOTFOUND, a TLS error) in `cause`; a
 * timeout is a DOMException whose only code is a legacy number. The
 * transport's word is the one the operator acts on, so it is appended.
 */
function describe(error: unknown): string {
  const e = error as { message?: string; cause?: unknown };
  const cause = e.cause as { code?: unknown; message?: string } | undefined;
  const message = e.message ?? String(error);
  const why = typeof cause?.code === 'string' ? cause.code : cause?.message;
  return why === undefined ? message : `${message} (${why})`;
}

export class CheckIn {
  private timer: NodeJS.Timeout | undefined;
  private closing = false;
  /** The failure the gateway is currently in (its sentence with the numbers blanked, so a 409 that says "3s ago" and then "4s ago" is one failure), or null while it answers. */
  private failing: string | null = null;

  constructor(private readonly opts: CheckInOptions) {}

  start(): void {
    this.schedule(0);
  }

  stop(): void {
    this.closing = true;
    clearTimeout(this.timer);
  }

  /** One check-in. Never throws: a failure is recorded and the next tick retries. */
  async once(): Promise<void> {
    const { opts } = this;
    try {
      const body: CheckInRequest = {
        nodeId: opts.nodeId,
        endpoint: opts.endpoint,
        intervalSeconds: opts.intervalSeconds,
        build: opts.build,
        reading: await opts.readReading(),
      };
      const res = await (opts.fetchImpl ?? fetch)(`${opts.gateway}/checkIn`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CHECK_IN_TIMEOUT_MS),
        // A front that redirects (a Caddy binding the gateway's domain
        // answers plain http with a 308 to https) is reported as what it
        // is. Followed, the redirect would cross origins and fetch would
        // drop the Authorization header on the way (the Fetch standard's
        // rule), so the gateway would answer 401 — and the operator would
        // read a wrong token where there is a wrong address (found by
        // review, 2026-09-14).
        redirect: 'manual',
      });
      if (res.status !== 200) {
        const text = await res.text();
        const location = res.headers.get('location');
        // Whole enough for the gateway's own refusals (its longest, the
        // 409 naming both endpoints of a shared node id, runs to about 260
        // characters — cut at 200 it lost its remedy), short enough that
        // a front's HTML error page does not flood the log.
        const body = text.slice(0, 400);
        throw new Error(
          location === null
            ? `gateway answered ${res.status}: ${body}`
            : `gateway answered ${res.status} redirecting to ${location} — DORMICE_GATEWAY_ENDPOINT must be the gateway's own address, not a front that redirects`,
        );
      }
      checkInResponseSchema.parse(await res.json());
      if (this.failing !== null) {
        opts.log.info(`check-in with gateway ${opts.gateway} answers again`);
        this.failing = null;
      }
    } catch (error) {
      const message = describe(error);
      const failure = message.replace(/\d+/g, '#');
      if (failure !== this.failing) {
        opts.log.warn(
          { gateway: opts.gateway, error: message },
          this.failing === null
            ? 'check-in failed; the gateway places nothing here and forwards no new names to this node until it answers again — retrying every interval'
            : 'check-in still failing, differently — retrying every interval',
        );
      }
      this.failing = failure;
    }
  }

  private schedule(delayMs: number): void {
    if (this.closing) return;
    this.timer = setTimeout(async () => {
      await this.once();
      this.schedule(this.opts.intervalSeconds * 1000);
    }, delayMs);
  }
}
