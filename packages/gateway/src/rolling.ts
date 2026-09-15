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
 * every node that reports an older build than the gateway's is behind.
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
 * pointer moves past it (a stuck node is not "upgrading"). The operator's
 * applyUpgrade {nodeId} puts it back in line: its tell is forgotten, it
 * reads behind again, and the roll tells it at its turn — after the node
 * upgrading now, if there is one, never beside it. Not a tell past the
 * order: the first version's hand was one ("told at its next check-in,
 * whatever the order says"), kept in the gateway's memory, and three
 * reviews in one day found three ways for that memory to outlive the
 * node it was for and tell two nodes into one minute (2026-09-15). One
 * node down at a time is the one thing the roll promises; a hand that
 * could break it was the wrong hand, and with it gone nothing is
 * remembered but the row.
 *
 * The row: the tell is nodes.upgrade_told_at, so a gateway restart
 * mid-roll neither forgets a node it told nor tells it twice, and every
 * verdict here is a function of the rows, the gateway's build and the
 * clock.
 *
 * Behind means older. A node whose build is newer than the gateway's — a
 * commit that landed on main after the gateway's machine upgraded and
 * before this node's turn came, or install.sh run on the node by hand —
 * is `ahead`, never told: install.sh pulls main's head, which is where
 * the node already is, so a tell would rebuild it for nothing and, twenty
 * minutes on, read it stuck with a remedy that repeats the mistake (found
 * by review, 2026-09-15). The gateway's own upgrade is what brings an
 * ahead node to current, and its reason says so.
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
  // Newer than the gateway's build is ahead, not behind (the module
  // comment has why), judged before the tell: a told node that comes back
  // on a newer build has upgraded, and reads ahead — not upgrading. The
  // commit's time is the order: main is trunk-based and linear, so a later
  // committer time is a later commit. Commits in one second tie, and a tie
  // reads behind. Ties are common in the history (a rebased series is
  // re-committed in a burst: 24 of main's last 300 commits share a second
  // with their neighbour, measured 2026-09-15) but not between the two
  // builds compared here: each was built by install.sh at its branch's
  // head at the time, and two heads a second apart would be two pushes a
  // second apart. A hand-built checkout of a mid-series commit is the one
  // way to reach the misjudgement, and it costs that node one rebuild.
  if (
    Date.parse(node.build.committedAt) > Date.parse(gatewayBuild.committedAt)
  ) {
    return down === null
      ? {
          state: 'ahead',
          reason: `runs ${node.build.commit} (committed ${node.build.committedAt}), newer than the gateway's ${gatewayBuild.commit} — a fleet upgrades from its gateway: upgrade the gateway (applyUpgrade there), and this node reads current`,
        }
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
      reason: `told to upgrade at ${node.upgradeToldAt.toISOString()} and still on ${node.build.commit} ${Math.round(sinceMs / 60_000)} minutes later${silence} — read journalctl -u dormice-upgrade and the upgrade log on the node, then put it back in line (applyUpgrade with its nodeId): it is told again at its turn`,
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
 * The fleet upgrade's live half: the gateway's build to judge against and
 * the fleet's rows — one object the check-in route and the upgrade routes
 * share. Nothing of its own: every verdict is a function of the rows, the
 * gateway's build and the clock (the module comment has why).
 */
export class Rolling {
  constructor(
    private readonly fleet: Fleet,
    private readonly gatewayBuild: BuildInfo | null,
  ) {}

  /**
   * The check-in's verdict for a node that just reported: a fulfilled tell
   * is cleared (the node is off the old build — on the gateway's, or ahead
   * of it); otherwise the rolling rule decides, and a tell is written to
   * the row before the answer carries it. Answers whether the node is told
   * now.
   */
  onCheckIn(node: NodeState, now: Date): boolean {
    const { state } = upgradeStateOf(node, this.gatewayBuild, now);
    if (state === 'current' || state === 'ahead') {
      if (node.upgradeToldAt !== null) {
        this.fleet.setUpgradeToldAt(node.id, null);
      }
      return false;
    }
    if (!rollingDecision(this.fleet.all(), this.gatewayBuild, node, now)) {
      return false;
    }
    this.fleet.setUpgradeToldAt(node.id, now);
    return true;
  }

  /**
   * The operator's hand on a stuck node (applyUpgrade {nodeId}): its tell
   * is forgotten, it reads behind, and the roll tells it at its turn.
   * Refused in words everywhere else. Nothing to forget on a node that is
   * current, ahead, behind (in line already), unavailable, unreachable or
   * unknown. And not on one upgrading: its tell is what the one-at-a-time
   * rule counts, and forgotten, the rule would see nobody upgrading and
   * tell the next node into the same minute — the twenty minutes to stuck
   * are the roll's promise, not a delay to be skipped. Answers the
   * refusal, or null when the tell was forgotten.
   */
  retell(
    node: NodeState,
    now: Date,
  ): { status: 400 | 409; message: string } | null {
    const { state, reason } = upgradeStateOf(node, this.gatewayBuild, now);
    switch (state) {
      case 'stuck':
        this.fleet.setUpgradeToldAt(node.id, null);
        return null;
      case 'upgrading':
        return {
          status: 409,
          message: `node ${node.id} is upgrading (${reason}) — it reads stuck twenty minutes after its tell if it is still on the old build, and can be put back in line from there; wait`,
        };
      case 'current':
        return {
          status: 400,
          message: `node ${node.id} already runs the gateway's build (${node.build?.commit ?? 'unknown'}) — nothing to upgrade`,
        };
      case 'behind':
        return {
          status: 400,
          message: `node ${node.id} is behind and in line — it is told at its next check-in once no other node is upgrading; nothing to do`,
        };
      case 'unreachable':
        return {
          status: 400,
          message: `node ${node.id} is not checking in (${reason}) — back and behind, it is told at its turn; gone for good, remove it`,
        };
      default:
        return {
          status: 400,
          message: `node ${node.id} cannot be told to upgrade: ${reason ?? state}`,
        };
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
