import {
  type BuildInfo,
  type CheckInRequest,
  checkInResponseSchema,
  type NodeConfigBundle,
  type NodeReading,
} from '@dormice/shared';
import type { Db } from './db/db';
import { countByState, listSandboxes } from './db/ledger';
import { type CpuSampler, readHostReading } from './host-metrics';
import type { SwapControl } from './swap';

/**
 * A node's reading for its check-in: the host half (host-metrics.ts), the
 * ledger's census, and what the daemon-managed swap holds — null where
 * the daemon manages none (a non-Linux host, the fake executor), which is
 * how the gateway knows to refuse a swap target for this node.
 */
export async function readNodeReading(
  db: Db,
  cpu: CpuSampler,
  dataDir: string,
  swap?: SwapControl,
): Promise<NodeReading> {
  const { byState, total } = countByState(listSandboxes(db));
  return {
    ...(await readHostReading(cpu, dataDir)),
    sandboxes: { total, byState },
    managedSwap:
      swap === undefined ? null : { activeGb: (await swap.status()).activeGb },
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
  /** The version of the configuration copy this node runs; null while it holds none (db/settings.ts). */
  configVersion: () => number | null;
  /** Makes a bundle the gateway answered with real on this node (node-config.ts applyConfig). */
  applyConfig: (bundle: NodeConfigBundle) => Promise<void>;
  log: CheckInLog;
  /**
   * The heartbeat watchdog's ear, for untilConfigured() alone: a node
   * waiting for its first bundle has no lifecycle work to beat, and each
   * attempt — answered or not, bounded by CHECK_IN_TIMEOUT_MS — is the
   * wait provably alive. The ticker never beats: a ticker's liveness must
   * not reassure the watchdog (main.ts has the 2026-08-13 lesson).
   */
  beat?: () => void;
  /** Test seam; production uses the platform's fetch. */
  fetchImpl?: typeof fetch;
}

/** A gateway that has not answered within this is a gateway not answering; the next tick tries again. */
const CHECK_IN_TIMEOUT_MS = 10_000;

/**
 * The node's check-in ticker: every interval, one POST /checkIn to the
 * gateway carrying the node's id, where it can be reached, its build, a
 * fresh reading and the version of the configuration copy it runs
 * (RULES/协议.md「网关」). The gateway learns of a node from its first
 * check-in — no registration verb, no nodes file — and reads two missed
 * check-ins as down. The answer is the gateway's configuration version,
 * and the whole bundle whenever the node's differs: the check-in IS the
 * configuration pull (design record #22) — a fresh node, a node that
 * missed an edit while the gateway was away, an operator's change a
 * second ago, all one mechanism, and nothing for the gateway to remember.
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
        configVersion: opts.configVersion(),
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
      const answer = checkInResponseSchema.parse(await res.json());
      if (this.failing !== null) {
        opts.log.info(`check-in with gateway ${opts.gateway} answers again`);
        this.failing = null;
      }
      if (answer.config !== undefined) {
        // A bundle that cannot be applied is this tick's failure: the copy
        // stays what it was, the next check-in reports the old version, and
        // the gateway answers the bundle again — the retry is the protocol.
        try {
          await opts.applyConfig(answer.config);
        } catch (error) {
          throw new Error(
            `configuration v${answer.config.version} from the gateway could not be applied: ${describe(error)}`,
          );
        }
      }
    } catch (error) {
      const message = describe(error);
      const failure = message.replace(/\d+/g, '#');
      if (failure !== this.failing) {
        // What the failure costs depends on where this node stands: one
        // holding a copy keeps serving and is merely not placed on; one
        // without (untilConfigured, at boot) is not listening at all, and
        // "the gateway forwards nothing here" would name the wrong
        // predicament (found by review, 2026-09-14).
        const cost =
          opts.configVersion() === null
            ? 'this node holds no configuration copy and does not listen until the gateway answers with one'
            : 'the gateway places nothing here and forwards no new names to this node until it answers again';
        opts.log.warn(
          { gateway: opts.gateway, error: message },
          this.failing === null
            ? `check-in failed; ${cost} — retrying every interval`
            : 'check-in still failing, differently — retrying every interval',
        );
      }
      this.failing = failure;
    }
  }

  /**
   * Blocks until this node holds a configuration copy: a check-in now,
   * then one per interval, until a bundle has been applied. For boot
   * (main.ts) — a node without configuration has nothing to build a
   * sandbox from and does not listen. Never gives up: the gateway is the
   * fleet's configuration and there is no other source; each failure is
   * logged once by once(), so a gateway down for an hour is one line. The
   * check-ins sent here carry `configVersion: null`, which is what keeps
   * the gateway from placing on this node before it listens.
   */
  async untilConfigured(): Promise<void> {
    while (!this.closing && this.opts.configVersion() === null) {
      await this.once();
      // Each attempt is the wait provably alive (CheckInOptions.beat): the
      // watchdog starts before boot's awaits, and without a beat it read a
      // node half an hour into waiting for its gateway as a stalled daemon
      // and exited it — every thirty minutes, for nothing (found by
      // review, 2026-09-14).
      this.opts.beat?.();
      if (this.opts.configVersion() !== null) return;
      await new Promise((resolve) =>
        setTimeout(resolve, this.opts.intervalSeconds * 1000),
      );
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
