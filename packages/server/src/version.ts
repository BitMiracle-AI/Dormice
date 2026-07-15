/**
 * The identity tsup baked into this build (tsup.config.ts): the commit the
 * dist was built from. In the built daemon these `process.env` reads are
 * compile-time literals; running from source (tests, tsx) they fall
 * through to the real environment and come back empty — an unbuilt tree
 * has no build identity, and null says so honestly.
 */
export interface BuildInfo {
  /** Short hash. */
  commit: string;
  /** The commit's subject line. */
  title: string;
  /** ISO 8601 UTC — the commit's time, not the build's. */
  committedAt: string;
}

export function readBuildInfo(): BuildInfo | null {
  const commit = process.env.DORMICE_BUILD_COMMIT;
  const title = process.env.DORMICE_BUILD_COMMIT_TITLE;
  const committedAt = process.env.DORMICE_BUILD_COMMIT_AT;
  if (!commit || !title || !committedAt) return null;
  return { commit, title, committedAt };
}
