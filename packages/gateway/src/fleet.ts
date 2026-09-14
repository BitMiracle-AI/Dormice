import type {
  BuildInfo,
  CheckInRequest,
  NodeReading,
  SandboxDisks,
  SandboxStateCounts,
} from '@dormice/shared';
import { eq } from 'drizzle-orm';
import type { Db } from './db/db';
import { nodes } from './db/schema';
import { bumpConfigVersion } from './db/settings';

/**
 * A node as the gateway knows it: the persistent row (id, endpoint,
 * addedAt) and what it last reported (memory — reported again at the next
 * check-in, gone with the process and rightly so). placedSinceCheckIn
 * counts the sandboxes the gateway sent here since the last reading, so a
 * burst inside one interval is counted against the node before its next
 * reading shows it (placement.ts); placedIds are the ones among them whose
 * create answered with an id, so a sandbox placed and destroyed inside one
 * interval — a short job, the exam's churn — is taken off the count again
 * instead of holding a slot the reading will never show (routes/destroy.ts).
 */
export interface NodeState {
  readonly id: string;
  endpoint: string;
  readonly addedAt: string;
  /** The node's own setting, from its row: managed swap on its data disk, GiB. */
  swapGb: number;
  /** The configuration version the node last reported running; null before it has said. */
  configVersion: number | null;
  lastCheckInAt: Date | null;
  intervalSeconds: number | null;
  build: BuildInfo | null;
  reading: NodeReading | null;
  placedSinceCheckIn: number;
  placedIds: Set<string>;
}

/**
 * How long after a gateway start a node that has not checked in yet is
 * still presumed alive. A restarted gateway knows its nodes from their
 * rows and nothing else: every lastCheckInAt is null, and "has not checked
 * in since the gateway started" is true of a healthy node for up to one
 * of its intervals. Judged by downReason alone, removeNode would let an
 * operator delete a running node in that window (found by review,
 * 2026-09-14). Two of the daemon's default intervals
 * (DORMICE_CHECK_IN_INTERVAL_SECONDS, 15): the gateway cannot know a
 * node's own interval before it has heard from it once.
 */
export const STARTUP_GRACE_MS = 2 * 15 * 1000;

/**
 * Why a node is not to be placed on right now, or null when it is fine:
 * never checked in since this gateway started, or silent for two of its
 * own intervals — the interval it stated in its last check-in, so the
 * exam's one-second nodes and production's fifteen-second nodes are judged
 * by the same rule. Two, not one: a check-in delayed by a busy event loop
 * or a slow reading is normal; two in a row missing is a node in trouble.
 * The same word answers listNodes' `reachable`.
 */
export function downReason(node: NodeState, now: Date): string | null {
  if (node.lastCheckInAt === null || node.intervalSeconds === null) {
    return 'has not checked in since the gateway started';
  }
  const silentMs = now.getTime() - node.lastCheckInAt.getTime();
  if (silentMs > 2 * node.intervalSeconds * 1000) {
    return `has not checked in for ${Math.round(silentMs / 1000)}s`;
  }
  return null;
}

/**
 * A node that has checked in since this gateway started and reported no
 * configuration copy: its daemon fetches its first bundle before it opens
 * its port (server/main.ts, CheckIn.untilConfigured), so until its next
 * check-in says otherwise nothing dialled there answers — the socket is
 * shut. Placement refuses it, a lookup does not dial it (find.ts), a
 * merged list does not wait on it (merge.ts). A node not heard from at
 * all since the start is not this: it may well be running on a copy it
 * kept, and is asked like any other.
 */
export function awaitingFirstConfig(node: NodeState): boolean {
  return node.reading !== null && node.configVersion === null;
}

/**
 * What to say of a node awaiting its first configuration, in place of
 * asking it: nothing (null) when its reading says it holds no sandbox —
 * there is nothing an answer would lack — and, when it holds some, the
 * sentence that names them as there and unreachable until its next
 * check-in says the port is open.
 */
export function awaitingFirstConfigWhy(node: NodeState): string | null {
  const total = node.reading?.sandboxes.total ?? 0;
  return total === 0
    ? null
    : `not listening — it holds ${total} sandboxes but no configuration copy yet, and its first bundle rides on its next check-in`;
}

/**
 * The figures that add up across the fleet, summed over the nodes that
 * have a reading — the census by state and the sandbox disks' bill — and
 * how many nodes that is. A node without a reading (not heard from since
 * this gateway started) contributes nothing, and `reported` says so: the
 * sums are a lower bound until every node has spoken. A node that is
 * down but did report contributes its last reading — its sandboxes are
 * still there, merely out of reach. One function for the check-in's
 * sample (db/fleet-samples.ts) and getFleetMetrics (routes/fleet.ts), so
 * the curve and the number under it can never disagree.
 */
export function sumReadings(nodes: readonly NodeState[]): {
  reported: number;
  sandboxes: { total: number; byState: SandboxStateCounts };
  sandboxDisks: SandboxDisks;
} {
  const byState: SandboxStateCounts = {
    active: 0,
    frozen: 0,
    stopped: 0,
    archived: 0,
    restoring: 0,
  };
  const sandboxDisks: SandboxDisks = {
    count: 0,
    nominalBytes: 0,
    actualBytes: 0,
  };
  let total = 0;
  let reported = 0;
  for (const node of nodes) {
    if (node.reading === null) continue;
    reported += 1;
    total += node.reading.sandboxes.total;
    for (const state of Object.keys(byState) as Array<
      keyof SandboxStateCounts
    >) {
      byState[state] += node.reading.sandboxes.byState[state];
    }
    // Optional on the wire for the rolling upgrade (shared gateway.ts):
    // a node on the previous build reports no disks, and its share is
    // simply not in the sum.
    const disks = node.reading.sandboxDisks;
    if (disks !== undefined) {
      sandboxDisks.count += disks.count;
      sandboxDisks.nominalBytes += disks.nominalBytes;
      sandboxDisks.actualBytes += disks.actualBytes;
    }
  }
  return { reported, sandboxes: { total, byState }, sandboxDisks };
}

/** What a check-in came to: taken (and whether it joined or moved), or refused with the sentence the node is told (routes/nodes.ts answers 409). */
export type CheckInOutcome =
  | { node: NodeState; joined: boolean; movedFrom: string | null }
  | { refused: string };

/**
 * The fleet: every node that has ever checked in. Rows come from the
 * database at start (a node that is down must still be known — its names
 * are not new names); everything else fills in as the nodes report.
 */
export class Fleet {
  private readonly members = new Map<string, NodeState>();

  /** When this gateway process started — the yardstick for STARTUP_GRACE_MS. */
  readonly startedAt: Date;

  constructor(
    private readonly db: Db,
    startedAt: Date = new Date(),
  ) {
    this.startedAt = startedAt;
    for (const row of db.select().from(nodes).all()) {
      this.members.set(row.id, {
        id: row.id,
        endpoint: row.endpoint,
        addedAt: row.addedAt,
        swapGb: row.swapGb,
        configVersion: null,
        lastCheckInAt: null,
        intervalSeconds: null,
        build: null,
        reading: null,
        placedSinceCheckIn: 0,
        placedIds: new Set(),
      });
    }
  }

  all(): NodeState[] {
    return [...this.members.values()];
  }

  get(id: string): NodeState | undefined {
    return this.members.get(id);
  }

  /**
   * A node reporting for duty. A first check-in adds the node (`joined`
   * says so, for the log); a changed endpoint is written through — the
   * node states where it lives, the gateway does not remember better —
   * and `movedFrom` names the old one, for the log. Except inside the
   * previous reporter's own interval: a different address that soon is a
   * second machine with the same DORMICE_NODE_ID (the daemon's default is
   * node-1), not a move, and is refused — written through, the two would
   * flip the endpoint at every check-in, a lookup would ask whichever is
   * current, a name on the other would read as new and be built again, on
   * two nodes, with no 409 ever (traced by review, 2026-09-14). The first
   * reporter keeps the id; the second is told why. A node that really
   * moved is taken at its next check-in, one interval on. The
   * placement counter restarts at zero: what was placed before this
   * reading is in it now, and what is still in flight on the node (its
   * row is written after the container is up) is in neither figure until
   * the next reading — one interval of slack, self-correcting, the same
   * as before.
   */
  checkIn(report: CheckInRequest, now = new Date()): CheckInOutcome {
    let node = this.members.get(report.nodeId);
    let joined = false;
    let movedFrom: string | null = null;
    if (node === undefined) {
      const addedAt = now.toISOString();
      this.db
        .insert(nodes)
        .values({ id: report.nodeId, endpoint: report.endpoint, addedAt })
        .run();
      node = {
        id: report.nodeId,
        endpoint: report.endpoint,
        addedAt,
        swapGb: 0,
        configVersion: null,
        lastCheckInAt: null,
        intervalSeconds: null,
        build: null,
        reading: null,
        placedSinceCheckIn: 0,
        placedIds: new Set(),
      };
      this.members.set(node.id, node);
      joined = true;
    } else if (node.endpoint !== report.endpoint) {
      if (
        node.lastCheckInAt !== null &&
        node.intervalSeconds !== null &&
        now.getTime() - node.lastCheckInAt.getTime() <
          node.intervalSeconds * 1000
      ) {
        const ago = Math.round(
          (now.getTime() - node.lastCheckInAt.getTime()) / 1000,
        );
        return {
          refused: `node ${report.nodeId} checked in from ${node.endpoint} ${ago}s ago and now from ${report.endpoint} — two daemons share one DORMICE_NODE_ID (give this one its own), or the node just moved (then its next check-in, an interval later, is taken)`,
        };
      }
      this.db
        .update(nodes)
        .set({ endpoint: report.endpoint })
        .where(eq(nodes.id, report.nodeId))
        .run();
      movedFrom = node.endpoint;
      node.endpoint = report.endpoint;
    }
    node.lastCheckInAt = now;
    node.intervalSeconds = report.intervalSeconds;
    node.build = report.build;
    node.reading = report.reading;
    node.configVersion = report.configVersion;
    node.placedSinceCheckIn = 0;
    node.placedIds.clear();
    return { node, joined, movedFrom };
  }

  /**
   * The one per-node setting, written to the row and counted as a
   * configuration change in the same transaction, so the node that pulls
   * the next bundle gets the new target under the new version and never
   * one without the other. Answers false for an unknown id.
   */
  setSwapGb(id: string, swapGb: number): boolean {
    const node = this.members.get(id);
    if (node === undefined) return false;
    this.db.transaction((tx) => {
      tx.update(nodes).set({ swapGb }).where(eq(nodes.id, id)).run();
      bumpConfigVersion(tx);
    });
    node.swapGb = swapGb;
    return true;
  }

  /** The operator's word that the node is gone for good (routes/nodes.ts refuses it for a node still checking in); one removed while briefly silent re-adds itself at its next check-in. */
  remove(id: string): boolean {
    const existed = this.members.delete(id);
    this.db.delete(nodes).where(eq(nodes.id, id)).run();
    return existed;
  }
}
