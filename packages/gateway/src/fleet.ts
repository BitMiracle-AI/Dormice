import {
  type BuildInfo,
  buildInfoSchema,
  type CheckInRequest,
  type NodeReading,
  nodeReadingSchema,
  type SandboxDisks,
  type SandboxStateCounts,
} from '@dormice/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './db/db';
import { type NodeRow, nodes } from './db/schema';
import { bumpConfigVersion } from './db/settings';

/**
 * A node as the gateway knows it: its row — id, endpoint, addedAt, the
 * swap target, and what it last reported: when and at what interval, the
 * configuration version, the build, the reading (written back at every
 * check-in since the fourth cut, so a restarted gateway starts from the
 * last check-in and not from nothing) — and the gateway's own counters.
 * placedSinceCheckIn counts the sandboxes the gateway sent here since the
 * last reading, so a burst inside one interval is counted against the
 * node before its next reading shows it (placement.ts); placedIds are the
 * ones among them whose create answered with an id, so a sandbox placed
 * and destroyed inside one interval — a short job, the exam's churn — is
 * taken off the count again instead of holding a slot the reading will
 * never show (routes/destroy.ts). The counters are memory: they count
 * what this process did since the reading, and a restarted one has done
 * nothing yet.
 */
export interface NodeState {
  readonly id: string;
  endpoint: string;
  readonly addedAt: string;
  /** The node's own setting, from its row: managed swap on its data disk, GiB. */
  swapGb: number;
  /** The configuration version the node last reported running; null before it has said. */
  configVersion: number | null;
  /** The last check-in taken; null for a row that has never checked in (the import pre-creates one). */
  lastCheckInAt: Date | null;
  intervalSeconds: number | null;
  build: BuildInfo | null;
  reading: NodeReading | null;
  /** Whether the node can upgrade itself, its own word (shared checkInRequestSchema.selfUpgrade); null = it did not say. */
  selfUpgrade: SelfUpgrade | null;
  /** When the fleet upgrade last told this node to upgrade (rolling.ts); null = never, or fulfilled. */
  upgradeToldAt: Date | null;
  /** The commit the node ran when it was told — the tell is fulfilled the moment it reports another (rolling.ts); null with a tell = a row written before this was recorded. */
  upgradeToldBuild: string | null;
  placedSinceCheckIn: number;
  placedIds: Set<string>;
}

export type SelfUpgrade = NonNullable<CheckInRequest['selfUpgrade']>;

const selfUpgradeSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
});

/**
 * What the fleet says for itself — a row it could not read back, a row it
 * could not write. Pino's shape (main.ts passes the gateway's logger);
 * silent by default, for the suites that embed a fleet.
 */
export interface FleetLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const SILENT_LOG: FleetLog = { info() {}, warn() {}, error() {} };

/**
 * Why a node is not to be placed on right now, or null when it is fine:
 * never checked in — a row the import pre-created, before the node's
 * first check-in — or silent for two of its own intervals: the interval
 * it stated in its last check-in, so the exam's one-second nodes and
 * production's fifteen-second nodes are judged by the same rule. Two,
 * not one: a check-in delayed by a busy event loop or a slow reading is
 * normal; two in a row missing is a node in trouble. The last check-in
 * is the row's as much as memory's (Fleet has why), so a restarted
 * gateway reads a node that checked in seconds before the restart as up
 * and one silent since long before it as down — and no rule here needs
 * to know how old the gateway is. The same word answers listNodes'
 * `reachable`.
 */
export function downReason(node: NodeState, now: Date): string | null {
  if (node.lastCheckInAt === null || node.intervalSeconds === null) {
    return 'has never checked in';
  }
  const silentMs = now.getTime() - node.lastCheckInAt.getTime();
  if (silentMs > 2 * node.intervalSeconds * 1000) {
    return `has not checked in for ${Math.round(silentMs / 1000)}s`;
  }
  return null;
}

/**
 * A node whose last check-in reported no configuration copy: its daemon
 * fetches its first bundle before it opens its port (server/main.ts,
 * CheckIn.untilConfigured), so until its next check-in says otherwise
 * nothing dialled there answers — the socket is shut. Placement refuses
 * it, a lookup does not dial it (find.ts), a merged list does not wait on
 * it (merge.ts). A node that has never checked in is not this: nothing
 * is known of it, and it is asked like any other.
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
 * how many nodes that is. A node without a reading (never checked in — a
 * row the import pre-created) contributes nothing, and `reported` says
 * so: the sums are a lower bound until every node has spoken once. A node
 * that is down but did report contributes its last reading — its
 * sandboxes are still there, merely out of reach — and so does every
 * node right after a gateway restart, from its row. One function for the
 * sampler's row (db/fleet-samples.ts) and getFleetMetrics
 * (routes/fleet.ts), so the curve and the number under it can never
 * disagree.
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

/** The row's share of one check-in: what the node said, as the columns hold it (load reads them back). */
type RowShare = Pick<
  typeof nodes.$inferInsert,
  | 'endpoint'
  | 'lastCheckInAt'
  | 'intervalSeconds'
  | 'configVersion'
  | 'build'
  | 'reading'
  | 'selfUpgrade'
>;

/**
 * The fleet: every node that has ever checked in, and the rows the import
 * pre-creates. Rows come from the database at start and carry what each
 * node last reported — a node that is down must still be known (its
 * names are not new names), and a restarted gateway must judge its nodes
 * by their last check-in, not by its own age: the third cut kept the
 * check-in in memory only, and every restart began with a thirty-second
 * grace in four places (placement, merged lists, the sampler, removeNode)
 * to cover for "silent since the gateway started" being true of every
 * node, the running ones included, for up to an interval. Memory is this
 * process's truth; the row is what it leaves the next one.
 */
export class Fleet {
  private readonly members = new Map<string, NodeState>();
  /** The nodes whose row the last check-in could not write — said once when it starts, once when it stops (persist). */
  private readonly unwritten = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly log: FleetLog = SILENT_LOG,
  ) {
    for (const row of db.select().from(nodes).all()) {
      this.members.set(row.id, this.load(row));
    }
  }

  /**
   * A row as memory. The two JSON columns are read back through the
   * shapes they were written from (the wire schemas): a column that fails
   * them — a hand edit, a build that wrote a shape this one no longer
   * reads — is null, said once here, and filled in again at the node's
   * next check-in; never a gateway that refuses to start over one node's
   * row.
   */
  private load(row: NodeRow): NodeState {
    return {
      id: row.id,
      endpoint: row.endpoint,
      addedAt: row.addedAt,
      swapGb: row.swapGb,
      configVersion: row.configVersion,
      lastCheckInAt:
        row.lastCheckInAt === null ? null : new Date(row.lastCheckInAt),
      intervalSeconds: row.intervalSeconds,
      build: this.parseJson(row.id, 'build', row.build, buildInfoSchema),
      reading: this.parseJson(
        row.id,
        'reading',
        row.reading,
        nodeReadingSchema,
      ),
      selfUpgrade: this.parseJson(
        row.id,
        'selfUpgrade',
        row.selfUpgrade,
        selfUpgradeSchema,
      ),
      upgradeToldAt: this.parseDate(row.upgradeToldAt),
      upgradeToldBuild: row.upgradeToldBuild,
      placedSinceCheckIn: 0,
      placedIds: new Set(),
    };
  }

  private parseDate(iso: string | null): Date | null {
    if (iso === null) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private parseJson<T>(
    nodeId: string,
    column: string,
    json: string | null,
    schema: z.ZodType<T>,
  ): T | null {
    if (json === null) return null;
    try {
      const parsed = schema.safeParse(JSON.parse(json));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON at all: said below, like a shape the schema refuses.
    }
    this.log.warn(
      { nodeId, column },
      "a column on the node's row is not readable and is dropped until its next check-in fills it in",
    );
    return null;
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
   *
   * Everything the node said goes to its row as well as to memory. A join
   * is the one write that must land — a node no row holds is unknown to
   * the next gateway process, and its names are new names there — so its
   * INSERT throws (a 500 the node retries an interval later). Every later
   * check-in's UPDATE is best-effort (persist has why).
   */
  checkIn(report: CheckInRequest, now = new Date()): CheckInOutcome {
    let node = this.members.get(report.nodeId);
    let joined = false;
    let movedFrom: string | null = null;
    const said: RowShare = {
      endpoint: report.endpoint,
      lastCheckInAt: now.toISOString(),
      intervalSeconds: report.intervalSeconds,
      configVersion: report.configVersion,
      build: report.build === null ? null : JSON.stringify(report.build),
      reading: JSON.stringify(report.reading),
      selfUpgrade:
        report.selfUpgrade === undefined
          ? null
          : JSON.stringify(report.selfUpgrade),
    };
    if (node === undefined) {
      const addedAt = now.toISOString();
      this.db
        .insert(nodes)
        .values({ id: report.nodeId, addedAt, ...said })
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
        selfUpgrade: null,
        upgradeToldAt: null,
        upgradeToldBuild: null,
        placedSinceCheckIn: 0,
        placedIds: new Set(),
      };
      this.members.set(node.id, node);
      joined = true;
    } else {
      if (node.endpoint !== report.endpoint) {
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
        movedFrom = node.endpoint;
      }
      this.persist(node.id, said);
    }
    node.endpoint = report.endpoint;
    node.lastCheckInAt = now;
    node.intervalSeconds = report.intervalSeconds;
    node.build = report.build;
    node.reading = report.reading;
    node.configVersion = report.configVersion;
    node.selfUpgrade = report.selfUpgrade ?? null;
    node.placedSinceCheckIn = 0;
    node.placedIds.clear();
    return { node, joined, movedFrom };
  }

  /**
   * The fleet upgrade's one mark on a node: when it was told to upgrade
   * and what it ran at that moment, or null once the tell is fulfilled
   * (rolling.ts). Written through, not best-effort — the tell rides on
   * the check-in's answer, and a gateway that forgot it told a node would
   * tell it again after a restart, the one thing the rolling upgrade
   * promises not to do; a write that fails fails the check-in, and the
   * node is told at the next.
   */
  setUpgradeTold(id: string, told: { at: Date; build: string } | null): void {
    const node = this.members.get(id);
    if (node === undefined) return;
    this.db
      .update(nodes)
      .set({
        upgradeToldAt: told === null ? null : told.at.toISOString(),
        upgradeToldBuild: told === null ? null : told.build,
      })
      .where(eq(nodes.id, id))
      .run();
    node.upgradeToldAt = told === null ? null : told.at;
    node.upgradeToldBuild = told === null ? null : told.build;
  }

  /**
   * The row's share of a check-in, best-effort: a write that fails — a
   * full disk, a file gone read-only — is said once, and the check-in is
   * taken all the same. Memory is this process's truth and the row is
   * what it leaves the next one; the configuration bundle riding on the
   * check-in's answer must not wait on the record of who reported what
   * (the sampler's stance, db/fleet-samples.ts: an observation's write
   * has no say over the control plane). Said once, not per check-in: one
   * failing disk is one situation, not four lines a minute per node —
   * and said again when the writes succeed, so the log has both ends.
   */
  private persist(id: string, said: RowShare): void {
    try {
      this.db.update(nodes).set(said).where(eq(nodes.id, id)).run();
      if (this.unwritten.delete(id)) {
        this.log.info(
          { nodeId: id },
          "the node's row takes its check-ins again",
        );
      }
    } catch (error) {
      if (!this.unwritten.has(id)) {
        this.unwritten.add(id);
        this.log.error(
          { nodeId: id, err: error },
          "the node's row could not be written at its check-in; the check-in is taken in memory, and a gateway restart would know the node only as of its last written check-in",
        );
      }
    }
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
