import type { BuildInfo, CheckInRequest, NodeReading } from '@dormice/shared';
import { eq } from 'drizzle-orm';
import type { Db } from './db/db';
import { nodes } from './db/schema';

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
  lastCheckInAt: Date | null;
  intervalSeconds: number | null;
  build: BuildInfo | null;
  reading: NodeReading | null;
  placedSinceCheckIn: number;
  placedIds: Set<string>;
}

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
 * The fleet: every node that has ever checked in. Rows come from the
 * database at start (a node that is down must still be known — its names
 * are not new names); everything else fills in as the nodes report.
 */
export class Fleet {
  private readonly members = new Map<string, NodeState>();

  constructor(private readonly db: Db) {
    for (const row of db.select().from(nodes).all()) {
      this.members.set(row.id, {
        id: row.id,
        endpoint: row.endpoint,
        addedAt: row.addedAt,
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
   * and `movedFrom` names the old one, for the log: a node that moves at
   * every check-in is two machines sharing one DORMICE_NODE_ID. The
   * placement counter restarts at zero: what was placed before this
   * reading is in it now, and what is still in flight on the node (its
   * row is written after the container is up) is in neither figure until
   * the next reading — one interval of slack, self-correcting, the same
   * as before.
   */
  checkIn(
    report: CheckInRequest,
    now = new Date(),
  ): { node: NodeState; joined: boolean; movedFrom: string | null } {
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
    node.placedSinceCheckIn = 0;
    node.placedIds.clear();
    return { node, joined, movedFrom };
  }

  /** The operator's word that the node is gone for good; a node still running re-adds itself at its next check-in. */
  remove(id: string): boolean {
    const existed = this.members.delete(id);
    this.db.delete(nodes).where(eq(nodes.id, id)).run();
    return existed;
  }
}
