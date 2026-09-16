import type {
  BuildInfo,
  NodeUpgradeState,
  NodeUpgradeView,
} from '@dormice/shared';
import { downReason, type Fleet, type NodeState, type Tell } from './fleet';

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
 * The row: the tell is nodes.upgrade_told_at and, beside it, the commit
 * the node ran when told (upgrade_told_build) — so a gateway restart
 * mid-roll neither forgets a node it told nor tells it twice, and every
 * verdict here is a function of the rows, the gateway's build and the
 * clock. Fulfilled means the node reports another commit than the one
 * it was told on, not the gateway's commit: the gateway may have been
 * upgraded again while the node built (a fix pushed on the heels of the
 * first push — the shape of every review day), and a node coming back on
 * the first push's commit has done exactly what it was told. Judged as
 * "still not on my build" it read upgrading for twenty minutes, then
 * stuck with a reason that said it had not moved when it had — and the
 * one-at-a-time rule held the whole roll for those twenty minutes (found
 * by review, 2026-09-16). Back on another commit it is judged afresh:
 * current, ahead, or behind and in line for the next tell.
 *
 * A node's own upgrade unit counts as upgrading too, told or not. The
 * node reports whether dormice-upgrade is alive on its machine
 * (selfUpgrade.running), and one that says so is not told: its previous
 * upgrade's installer is finishing — doctor runs on for seconds after
 * the daemon it restarted is back — or an operator ran install.sh on it
 * by hand. A tell landing in those seconds was refused by the unit's
 * mutex on the node and, said once, held the roll until the node read
 * stuck (measured 2026-09-16: an eight-second window at the end of every
 * upgrade, hit by every fix pushed on the heels of a push). The node
 * states the fact, the gateway waits it out and tells at the first
 * check-in that says the unit has ended — no memory of a tell on the
 * node, and a hand-run upgrade shows on the version page as what it is.
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
 * Whether the node's tell stands: it was told, and still reports the
 * commit it was told on. Reporting another, it has done what it was told
 * (the module comment has why that, and not the gateway's commit, is the
 * measure) and the tell is fulfilled.
 */
function tellStands(
  node: NodeState,
): node is NodeState & { upgradeTold: Tell; build: BuildInfo } {
  return (
    node.upgradeTold !== null &&
    node.build !== null &&
    node.build.commit === node.upgradeTold.build
  );
}

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
  if (tellStands(node)) {
    const sinceMs = now.getTime() - node.upgradeTold.at.getTime();
    const aside =
      down !== null
        ? ` (${down})`
        : node.selfUpgrade?.running === true
          ? ' (an upgrade unit is running on it)'
          : '';
    if (sinceMs < UPGRADE_TOLD_TIMEOUT_MS) {
      return {
        state: 'upgrading',
        reason: `told ${Math.round(sinceMs / 1000)}s ago, still on ${node.build.commit}${aside}`,
      };
    }
    return {
      state: 'stuck',
      reason: `told to upgrade at ${node.upgradeTold.at.toISOString()} and still on ${node.build.commit} ${Math.round(sinceMs / 60_000)} minutes later${aside} — read journalctl -u dormice-upgrade and the upgrade log on the node, then put it back in line (applyUpgrade with its nodeId): it is told again at its turn`,
    };
  }
  if (down !== null) {
    return { state: 'unreachable', reason: down };
  }
  // An upgrade unit alive on the node's machine is an upgrade in
  // progress whoever started it (the module comment has the two ways):
  // waited out — not told, and counted by the one-at-a-time rule. Judged
  // after the silence, unlike a tell: a tell has the twenty-minute clock
  // to bound it and this has none, so a node that said "running" and
  // went quiet for good reads unreachable, not upgrading forever.
  if (node.selfUpgrade?.running === true) {
    return {
      state: 'upgrading',
      reason:
        'an upgrade unit is running on the node (dormice-upgrade) — its previous upgrade finishing, or install.sh run there by hand; it is told at its turn once that has ended',
    };
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
   * is cleared from the row (the node is off the commit it was told on —
   * on the gateway's, ahead of it, or behind it once more because the
   * gateway moved on meanwhile: upgradeStateOf no longer reads it as
   * upgrading or stuck); then the rolling rule decides, and a tell is
   * written to the row before the answer carries it. Answers whether the
   * node is told now — which a node just back from one upgrade may be,
   * when the gateway is already past the build it came back on.
   */
  onCheckIn(node: NodeState, now: Date): boolean {
    const { state } = upgradeStateOf(node, this.gatewayBuild, now);
    // Fulfilled: the node is off the commit it was told on. Or moot: it
    // reads current or ahead while still on it — the gateway went back
    // to an older build (install.sh by hand on its machine), and a tell
    // kept through that would read the node stuck the day the gateway
    // passed it again.
    if (
      node.upgradeTold !== null &&
      (!tellStands(node) || state === 'current' || state === 'ahead')
    ) {
      this.fleet.setUpgradeTold(node.id, null);
    }
    if (
      node.build === null ||
      !rollingDecision(this.fleet.all(), this.gatewayBuild, node, now)
    ) {
      return false;
    }
    this.fleet.setUpgradeTold(node.id, { at: now, build: node.build.commit });
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
  unstick(
    node: NodeState,
    now: Date,
  ): { status: 400 | 409; message: string } | null {
    const { state, reason } = upgradeStateOf(node, this.gatewayBuild, now);
    switch (state) {
      case 'stuck':
        this.fleet.setUpgradeTold(node.id, null);
        return null;
      case 'upgrading':
        return {
          status: 409,
          message:
            node.upgradeTold === null
              ? `node ${node.id} is upgrading (${reason}) — not on a tell, so nothing to put back in line; it reads behind once the unit has ended and is told at its turn`
              : `node ${node.id} is upgrading (${reason}) — it reads stuck twenty minutes after its tell if it is still on the old build, and can be put back in line from there; wait`,
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
          toldAt: node.upgradeTold?.at.toISOString() ?? null,
          reason,
        };
      });
  }
}
