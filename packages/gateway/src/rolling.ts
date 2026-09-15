import type {
  BuildInfo,
  NodeUpgradeState,
  NodeUpgradeView,
} from '@dormice/shared';
import { downReason, type Fleet, type NodeState } from './fleet';

/**
 * The fleet upgrade, rolled over the nodes by their check-ins (design
 * record #32: the gateway changes a node's target, the node upgrades
 * itself when it sees it, and the next node's turn comes when it is back
 * on the new build). The gateway's machine upgrades first — install.sh
 * there restarts its gateway and its node together — and from then on
 * every node that reports another build than the gateway's is behind.
 *
 * Told at a check-in, one node at a time: the answer carries `upgrade:
 * true` (shared checkInResponseSchema), the node runs its own updater
 * (install.sh in a systemd unit, back on the new build within minutes),
 * and no other node is told while one is upgrading — the fleet loses one
 * node's sandboxes for a few tens of seconds, never two nodes' at once.
 *
 * Told once. A node still on the old build UPGRADE_TOLD_TIMEOUT_MS after
 * its tell is stuck: named as such with where to look, and never re-told
 * on its own — a node whose build fails every time would otherwise
 * rebuild every twenty minutes, on the CPU its sandboxes run on. The
 * pointer moves past it (a stuck node is not "upgrading"), and the
 * operator's applyUpgrade {nodeId} is the hand that tells it again,
 * whatever the rolling order says at that moment. The tell is on the
 * node's row (nodes.upgrade_told_at), so a gateway restart mid-roll
 * neither forgets a node it told nor tells it twice; the operator's
 * re-tell is memory — a gateway restarted before the node's next check-in
 * forgets it, and the operator clicks again.
 */

/** How long a told node has to come back on the new build before it is stuck: a pull, a build and a restart take a few minutes; twenty is a build that failed. */
export const UPGRADE_TOLD_TIMEOUT_MS = 20 * 60_000;

/**
 * One node's standing against the gateway's build, from its last
 * check-in (shared upgrade.ts nodeUpgradeViewSchema has each state's
 * meaning). Pure: the same inputs give the same answer, and the suite
 * walks every branch.
 */
export function upgradeStateOf(
  node: NodeState,
  gatewayBuild: BuildInfo | null,
  now: Date,
): { state: NodeUpgradeState; reason: string | null } {
  if (gatewayBuild === null) {
    return {
      state: 'unknown',
      reason:
        'the gateway carries no build identity (built outside a git checkout) — nothing to compare the node against',
    };
  }
  if (node.build === null) {
    return {
      state: 'unknown',
      reason:
        node.lastCheckInAt === null
          ? 'the node has never checked in'
          : 'the node reports no build identity (built outside a git checkout)',
    };
  }
  const down = downReason(node, now);
  if (node.build.commit === gatewayBuild.commit) {
    return down === null
      ? { state: 'current', reason: null }
      : { state: 'unreachable', reason: down };
  }
  // A told node is upgrading or stuck whether or not it is checking in:
  // its daemon restarts near the end of install.sh and misses a check-in
  // or two by design, and were that silence read as "unreachable" the
  // one-at-a-time rule would see nobody upgrading and tell the next node
  // into the same minute. The silence is said in the reason instead.
  if (node.upgradeToldAt !== null) {
    const sinceMs = now.getTime() - node.upgradeToldAt.getTime();
    const silence = down === null ? '' : ` (${down})`;
    if (sinceMs < UPGRADE_TOLD_TIMEOUT_MS) {
      return {
        state: 'upgrading',
        reason: `told ${Math.round(sinceMs / 1000)}s ago, still on ${node.build.commit}${silence}`,
      };
    }
    return {
      state: 'stuck',
      reason: `told to upgrade at ${node.upgradeToldAt.toISOString()} and still on ${node.build.commit} ${Math.round(sinceMs / 60_000)} minutes later${silence} — read journalctl -u dormice-upgrade and the upgrade log on the node, then tell it again (applyUpgrade with its nodeId)`,
    };
  }
  if (down !== null) {
    return { state: 'unreachable', reason: down };
  }
  if (node.selfUpgrade === null) {
    return {
      state: 'unavailable',
      reason: `the node runs ${node.build.commit} and does not say whether it can upgrade itself (a build from before the fleet upgrade) — run install.sh on it`,
    };
  }
  if (!node.selfUpgrade.available) {
    return {
      state: 'unavailable',
      reason: `${node.selfUpgrade.reason ?? 'the node cannot upgrade itself'} — run install.sh on it`,
    };
  }
  return { state: 'behind', reason: null };
}

/**
 * Whether this node, checking in now, is told to upgrade: it is behind
 * (upgradeStateOf), and no other node is upgrading right now — the one at
 * a time rule. Pure, over the fleet's current standings.
 */
export function rollingDecision(
  nodes: readonly NodeState[],
  gatewayBuild: BuildInfo | null,
  node: NodeState,
  now: Date,
): boolean {
  if (upgradeStateOf(node, gatewayBuild, now).state !== 'behind') return false;
  return !nodes.some(
    (other) =>
      other.id !== node.id &&
      upgradeStateOf(other, gatewayBuild, now).state === 'upgrading',
  );
}

/**
 * The fleet upgrade's live half: the gateway's build to judge against,
 * the operator's pending re-tells, and the check-in's verdicts — one
 * object the check-in route and the upgrade routes share.
 */
export class Rolling {
  /** Nodes the operator told to upgrade again (applyUpgrade {nodeId}), told at their next check-in whatever the order says. Memory: see the module comment. */
  private readonly retell = new Set<string>();

  constructor(
    private readonly fleet: Fleet,
    private readonly gatewayBuild: BuildInfo | null,
  ) {}

  /**
   * The check-in's verdict for a node that just reported, in order: a
   * fulfilled tell is cleared (the node is back on the gateway's build);
   * a pending re-tell is honored; otherwise the rolling rule decides. Any
   * tell is written to the row before the answer carries it. Answers
   * whether the node is told now.
   */
  onCheckIn(node: NodeState, now: Date): boolean {
    const { state } = upgradeStateOf(node, this.gatewayBuild, now);
    if (state === 'current' && node.upgradeToldAt !== null) {
      this.fleet.setUpgradeToldAt(node.id, null);
      this.retell.delete(node.id);
      return false;
    }
    const tell =
      (this.retell.has(node.id) &&
        (state === 'behind' || state === 'stuck' || state === 'upgrading')) ||
      rollingDecision(this.fleet.all(), this.gatewayBuild, node, now);
    if (!tell) return false;
    this.fleet.setUpgradeToldAt(node.id, now);
    this.retell.delete(node.id);
    return true;
  }

  /**
   * The operator's re-tell (applyUpgrade {nodeId}): honored at the node's
   * next check-in. Refused in words when it would do nothing — a node on
   * the gateway's build, one that cannot upgrade itself, one whose build
   * is unknown — and told to wait for an unreachable one; a node merely
   * behind or upgrading is taken too (the operator's hand outranks the
   * order). Answers the refusal, or null when the re-tell is pending.
   */
  requestRetell(
    node: NodeState,
    now: Date,
  ): { status: 400 | 409; message: string } | null {
    const { state, reason } = upgradeStateOf(node, this.gatewayBuild, now);
    switch (state) {
      case 'current':
        return {
          status: 400,
          message: `node ${node.id} already runs the gateway's build (${node.build?.commit ?? 'unknown'}) — nothing to upgrade`,
        };
      case 'unavailable':
      case 'unknown':
        return {
          status: 400,
          message: `node ${node.id} cannot be told to upgrade: ${reason ?? state}`,
        };
      case 'unreachable':
        return {
          status: 409,
          message: `node ${node.id} is not checking in (${reason}) — it is told at its next check-in; retry once it is back, or remove it if it is gone for good`,
        };
      default:
        this.retell.add(node.id);
        return null;
    }
  }

  /** Every node's standing right now (getUpgradeStatus.nodes), in node-id order. */
  states(now: Date): NodeUpgradeView[] {
    return this.fleet
      .all()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => {
        const { state, reason } = upgradeStateOf(node, this.gatewayBuild, now);
        return {
          id: node.id,
          build: node.build,
          state,
          toldAt: node.upgradeToldAt?.toISOString() ?? null,
          reason,
        };
      });
  }
}
