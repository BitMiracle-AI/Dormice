import { awaitingFirstConfig, downReason, type NodeState } from './fleet';

export interface PlacementKnobs {
  /** A reading above this refuses the node. */
  cpuLimitPct: number;
  /** Active sandboxes plus placements since the reading at or above this refuse the node. */
  activeLimit: number;
  /** A data disk with less than this available refuses the node. */
  minDiskAvailableBytes: number;
}

/** One node's refusal, in the words the 503 repeats: `<id>: <reason>`. */
export interface NodeRefusal {
  nodeId: string;
  reason: string;
}

export interface Placement {
  /** The node to create on, or null when every node refused. */
  node: NodeState | null;
  /** Every node that refused and why — the 503's body when node is null. */
  refused: NodeRefusal[];
}

/**
 * Where a new sandbox goes: four gates, then one score. Pure — it reads
 * what the nodes last reported and never asks a node.
 *
 * A node that is down (fleet.ts downReason: no check-in since the gateway
 * started, or two of its own intervals silent) is refused: placing blind
 * is how a gateway puts the twenty-first sandbox on the box that just
 * fell over. A node whose whole-machine CPU is above the limit is
 * refused; a null reading passes — the first check-in after a node
 * restart has no delta to report, and "don't know yet" is not
 * "saturated". A node at its active ceiling is refused, counting what
 * this gateway placed there since the reading: frozen sandboxes are not
 * counted, on purpose — they cost swap, not CPU or dockerd attention, a
 * node holds thousands of them, and counting them would shut the gate
 * from the first minute of a cut-over and never open it again. A node
 * whose data disk is below the floor is refused (design record #36): a
 * full data disk stops every sandbox on the node at once, and the node's
 * own create answering 500 would otherwise be re-chosen — scored emptiest,
 * because nothing it fails to build ever counts — for every new name
 * until someone noticed. A missing disk reading passes, like the CPU:
 * unknown is not full.
 *
 * Among the nodes that pass, the emptiest by active density wins: active
 * sandboxes plus what this gateway placed there since the reading, per
 * core. Per core because the one density ever measured is per core (535
 * sandboxes healthy and 882 dead on 128 cores, 2026-09-11) and a 64-core
 * node with 40 sandboxes has more room than an 8-core node with 6;
 * counting the in-flight placements is what spreads a burst — a reading
 * is fifteen seconds old, a hundred creates arrive inside that window,
 * and a score that does not move with each pick sends all hundred to the
 * node the reading favoured (reproduced twice, 2026-09-12). Ties go to the
 * most available memory — the resource the freeze/swap design overcommits
 * and an overloaded host runs out of first — then to the id, so the
 * choice is stable and explainable. Memory does not gate placement: a
 * node with room per core and little memory left is still chosen, and
 * memory pressure is judged where it is felt, by the node's own admission
 * (design record #27, after the cluster), not guessed from a
 * fifteen-second-old figure the picks do not move. And a node whose last
 * check-in reported no configuration copy is refused: a daemon booting
 * without one fetches it before it listens, and until its next check-in
 * says otherwise the gateway must assume the port is still shut.
 */
export function pick(
  nodes: readonly NodeState[],
  knobs: PlacementKnobs,
  now: Date,
): Placement {
  const refused: NodeRefusal[] = [];
  const candidates: Array<{
    node: NodeState;
    /** (active + placed since the reading) per core. */
    load: number;
    memAvailableBytes: number;
  }> = [];
  for (const node of nodes) {
    const refuse = (reason: string) =>
      refused.push({ nodeId: node.id, reason });
    const down = downReason(node, now);
    if (down !== null) {
      refuse(down);
      continue;
    }
    const reading = node.reading;
    if (reading === null) {
      refuse('has not reported a reading');
      continue;
    }
    // A node that reported no configuration copy has no defaults to build
    // a sandbox from — and is not listening yet (fleet.ts
    // awaitingFirstConfig): a create sent there would be refused at the
    // socket.
    if (awaitingFirstConfig(node)) {
      refuse(
        'holds no configuration copy yet — its first bundle rides on its next check-in',
      );
      continue;
    }
    const cpuUsedPct = reading.host.cpuUsedPct;
    if (cpuUsedPct !== null && cpuUsedPct > knobs.cpuLimitPct) {
      refuse(
        `cpu ${Math.round(cpuUsedPct)}% is above the ${knobs.cpuLimitPct}% limit`,
      );
      continue;
    }
    const active = reading.sandboxes.byState.active;
    const placed = node.placedSinceCheckIn;
    if (active + placed >= knobs.activeLimit) {
      refuse(
        `${active} active sandboxes + ${placed} placed since the reading reach the ${knobs.activeLimit} limit`,
      );
      continue;
    }
    const disk = reading.dataDisk;
    if (disk !== null && disk.availableBytes < knobs.minDiskAvailableBytes) {
      refuse(
        `data disk has ${gib(disk.availableBytes)} GiB available, below the ${gib(knobs.minDiskAvailableBytes)} GiB floor`,
      );
      continue;
    }
    candidates.push({
      node,
      load: (active + placed) / Math.max(1, reading.host.cpuCount),
      memAvailableBytes: reading.host.memAvailableBytes,
    });
  }
  candidates.sort(
    (a, b) =>
      a.load - b.load ||
      b.memAvailableBytes - a.memAvailableBytes ||
      (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0),
  );
  return { node: candidates[0]?.node ?? null, refused };
}

function gib(bytes: number): string {
  return (bytes / 2 ** 30).toFixed(1);
}

/** The 503's sentence when every node refused: each node and its reason — or that there is no node at all. */
export function refusalMessage(placement: Placement): string {
  if (placement.refused.length === 0) {
    return 'no node can take a new sandbox: no node has checked in with this gateway yet';
  }
  return `no node can take a new sandbox right now — ${placement.refused
    .map((r) => `${r.nodeId}: ${r.reason}`)
    .join('; ')}`;
}
