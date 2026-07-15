import { z } from 'zod';

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
 * Nothing checks in the background; this verb runs when asked, with a
 * short-lived server-side cache to keep a busy console polite.
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
 * applyUpgrade() — the one-click upgrade. The daemon launches install.sh
 * (re-running it IS the upgrade — one script for manual and one-click) in
 * a systemd transient unit, detached from its own lifetime: the upgrade's
 * last step restarts the daemon, and a child process would die with its
 * parent mid-build. The unit name doubles as the mutex — a second apply
 * while one runs is refused with 409, the Coolify double-click corruption
 * made structural. The verb takes no parameters on purpose: nothing from
 * the request ever reaches a root command line.
 *
 * Refused (400) when one-click is unavailable — fake executor, no git
 * checkout, no systemd. Watch progress with getUpgradeStatus.
 */
export const applyUpgradeRequestSchema = z.object({});

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

export const getUpgradeStatusResponseSchema = z.object({
  /** Can this daemon one-click upgrade itself at all? */
  available: z.boolean(),
  /** Why not, when available is false — the console shows the manual path instead. */
  unavailableReason: z.string().nullable(),
  /** Is the systemd unit alive right now? */
  running: z.boolean(),
  /** The most recent run's report; null when no one-click upgrade ever ran. */
  last: upgradeRunSchema.nullable(),
  /** The tail of the run's output — real progress, straight from the script. */
  log: z.string().nullable(),
});

export type GetUpgradeStatusResponse = z.infer<
  typeof getUpgradeStatusResponseSchema
>;
