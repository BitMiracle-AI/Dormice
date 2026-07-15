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
