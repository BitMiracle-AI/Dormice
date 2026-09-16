import { z } from 'zod';
import { buildInfoSchema } from './gateway';

/**
 * The upgrade verbs, on a node and at the gateway. On a node they are
 * the node's own (the emergency path: ssh in, curl its loopback). At the
 * gateway they are the fleet's (the fourth cut, 2026-09-15): checkUpgrade
 * compares the gateway's build, applyUpgrade upgrades the gateway's
 * machine — and once the gateway runs the new build, every node behind it
 * is told at its check-in to upgrade itself, one node at a time
 * (gateway.ts checkInResponseSchema.upgrade), and getUpgradeStatus lists
 * each node's standing.
 */

/**
 * checkUpgrade() — is a newer Dormice available for this daemon?
 *
 * There are no release tags yet: main is trunk-based and every commit
 * passes the acceptance chain, so "a version" is honestly a git commit.
 * The daemon's identity is the commit baked into its dist at build time —
 * deliberately not the checkout's HEAD, which moves on `git pull` while
 * the running process does not. The comparison is that built commit
 * against the origin's main (`git fetch` touches .git only, never the
 * working tree), so "pulled but not rebuilt" still honestly reads behind.
 *
 * The check reaches the network, so failures are data, not surprises:
 * `check` is null and `checkError` says why (the getIngress probe
 * precedent — the observation succeeded, the probe inside it did not).
 * Nothing checks on a timer; this verb runs when a human arrives — the
 * console asks once per open, the version page and its button ask again
 * — with a short-lived server-side cache to keep a busy console polite.
 */
export const checkUpgradeRequestSchema = z.object({
  /** Bypass the server-side cache — the "check now" button. */
  force: z.boolean().default(false),
});

export type CheckUpgradeRequest = z.input<typeof checkUpgradeRequestSchema>;

export const upgradeCommitSchema = z.object({
  /** Short hash. */
  commit: z.string(),
  /** The commit's subject line — trunk commit titles are the changelog. */
  title: z.string(),
});

export const checkUpgradeResponseSchema = z.object({
  /**
   * The identity baked into the running build. Null when the dist was
   * built outside a git checkout — an honest "I don't know who I am",
   * never a guess.
   */
  current: z
    .object({
      commit: z.string(),
      title: z.string(),
      /** ISO 8601 UTC — the commit's time, not the build machine's clock. */
      committedAt: z.iso.datetime(),
    })
    .nullable(),
  /** The comparison against origin's main. Null exactly when checkError says why. */
  check: z
    .object({
      /** ISO 8601 UTC — when the fetch actually ran (may predate this response: see cached). */
      checkedAt: z.iso.datetime(),
      /** True when this answer came from the server-side cache instead of a fresh fetch. */
      cached: z.boolean(),
      latest: upgradeCommitSchema,
      /** Commits on origin/main that this build lacks. */
      behindBy: z.number().int().min(0),
      /**
       * Commits this build has that origin/main lacks. Non-zero means the
       * checkout diverged (local commits, force-push upstream) — install.sh
       * pulls --ff-only, so a one-click upgrade would refuse anyway; the
       * daemon says so up front.
       */
      aheadBy: z.number().int().min(0),
      /** Server-adjudicated: behind and not diverged. Clients never re-derive. */
      upgradable: z.boolean(),
      /** What the upgrade would bring, newest first, capped — the changelog preview. */
      commits: z.array(upgradeCommitSchema),
    })
    .nullable(),
  /**
   * Why check is null: no git checkout under the daemon, no baked
   * identity to compare, or the fetch itself failed (network, mirror).
   */
  checkError: z.string().nullable(),
});

export type CheckUpgradeResponse = z.infer<typeof checkUpgradeResponseSchema>;

/**
 * applyUpgrade() — the one-click upgrade. The process launches install.sh
 * (re-running it IS the upgrade — one script for manual and one-click) in
 * a systemd transient unit, detached from its own lifetime: the upgrade's
 * last step restarts the process, and a child would die with its parent
 * mid-build. The unit name doubles as the mutex — a second apply while
 * one runs is refused with 409, the Coolify double-click corruption made
 * structural. Nothing from the request ever reaches a root command line.
 *
 * At the gateway, without `nodeId`, this is the fleet upgrade: the
 * gateway's machine upgrades (its gateway and its node together), and the
 * nodes behind follow — each is told at its check-in, one at a time, once.
 * With `nodeId` it is the operator's hand on one stuck node: a node told
 * once that is still on the old build twenty minutes later is `stuck`
 * (getUpgradeStatus), never re-told on its own — a node whose build keeps
 * failing must not rebuild every twenty minutes on the sandboxes' CPU —
 * and this puts it back in line: its tell is forgotten, it reads behind,
 * and the roll tells it at its turn, after the node upgrading now if
 * there is one, never beside it. On a node `nodeId` is meaningless and
 * refused.
 *
 * Refused (400) when one-click is unavailable — fake executor, no git
 * checkout, no systemd. Watch progress with getUpgradeStatus.
 */
export const applyUpgradeRequestSchema = z.object({
  /** At the gateway: put this stuck node back in line — its tell is forgotten, and the roll tells it again at its turn (400 on any other state, 409 while it is upgrading). Absent: upgrade the gateway's machine, then roll the fleet. */
  nodeId: z.string().min(1).optional(),
});

export type ApplyUpgradeRequest = z.infer<typeof applyUpgradeRequestSchema>;

export const applyUpgradeResponseSchema = z.object({
  started: z.literal(true),
});

export type ApplyUpgradeResponse = z.infer<typeof applyUpgradeResponseSchema>;

/**
 * What install.sh reports into status.json (--status-dir): the whole
 * truth of one run. `rolled-back` means the build failed after git pull
 * and the code was put back and rebuilt at the commit that was running —
 * the daemon was not restarted and keeps serving.
 */
export const upgradeRunSchema = z.object({
  state: z.enum(['running', 'succeeded', 'failed', 'rolled-back']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** The commit that was running before the pull; null on a fresh install. */
  fromCommit: z.string().nullable(),
  /** The commit the checkout moved to; null until the pull happened. */
  toCommit: z.string().nullable(),
  error: z.string().nullable(),
});

export type UpgradeRun = z.infer<typeof upgradeRunSchema>;

/**
 * getUpgradeStatus() — the upgrade execution window. `running` is read
 * from systemd (the unit's liveness, not the status file's claim): a
 * status file stuck at "running" with no live unit means the process died
 * without reporting, and the daemon adjudicates that into an honest
 * failure instead of showing an upgrade that never ends.
 */
export const getUpgradeStatusRequestSchema = z.object({});

export type GetUpgradeStatusRequest = z.infer<
  typeof getUpgradeStatusRequestSchema
>;

/**
 * Where one node stands against the gateway's build, as the gateway
 * judges it from the node's last check-in (gateway rolling.ts):
 *   current      the node runs the gateway's build
 *   ahead        a build newer than the gateway's — a commit that landed on
 *                main while the fleet was rolling, or install.sh run on the
 *                node by hand — never told; the gateway's own upgrade
 *                brings it to current
 *   behind       an older build, able to upgrade itself, not told yet — its
 *                turn comes when no other node is upgrading
 *   upgrading    told within the last twenty minutes, not back yet — or,
 *                by its own word, an upgrade unit is running on it (its
 *                previous upgrade's installer finishing, or install.sh
 *                run there by hand); not told until that has ended
 *   stuck        told, still on the old build twenty minutes on — never
 *                re-told on its own; applyUpgrade {nodeId} puts it back
 *                in line
 *   unavailable  another build, but the node cannot upgrade itself (its
 *                own reason: no checkout, no systemd, an older build that
 *                does not say) — run install.sh on it by hand
 *   unreachable  not checking in (two of its intervals silent)
 *   unknown      no build identity to compare, the node's or the gateway's
 */
export const NODE_UPGRADE_STATES = [
  'current',
  'ahead',
  'behind',
  'upgrading',
  'stuck',
  'unavailable',
  'unreachable',
  'unknown',
] as const;

export type NodeUpgradeState = (typeof NODE_UPGRADE_STATES)[number];

export const nodeUpgradeViewSchema = z.object({
  id: z.string(),
  build: buildInfoSchema.nullable(),
  state: z.enum(NODE_UPGRADE_STATES),
  /** ISO 8601 UTC — when the node was last told to upgrade; null = never, or its last tell was fulfilled. */
  toldAt: z.iso.datetime().nullable(),
  /** In the gateway's words, for every state but current and behind: why it is ahead, stuck, unavailable, unreachable or unknown; how long it has been upgrading. */
  reason: z.string().nullable(),
});

export type NodeUpgradeView = z.infer<typeof nodeUpgradeViewSchema>;

export const getUpgradeStatusResponseSchema = z.object({
  /** Can this process one-click upgrade its machine at all? */
  available: z.boolean(),
  /** Why not, when available is false — the console shows the manual path instead. */
  unavailableReason: z.string().nullable(),
  /** Is the systemd unit alive right now? */
  running: z.boolean(),
  /** The most recent run's report; null when no one-click upgrade ever ran. */
  last: upgradeRunSchema.nullable(),
  /** The tail of the run's output — real progress, straight from the script. */
  log: z.string().nullable(),
  /** The gateway's answer carries every node's standing; a node's own answer has no nodes to speak of. */
  nodes: z.array(nodeUpgradeViewSchema).optional(),
});

export type GetUpgradeStatusResponse = z.infer<
  typeof getUpgradeStatusResponseSchema
>;
