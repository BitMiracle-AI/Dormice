// Site-wide constants, collected in one place so the layout metadata, the
// landing sections and the chrome never drift apart. Page-local copy stays
// in its section component; only text used from more than one place lives
// here.
export const GITHUB_URL = 'https://github.com/BitMiracle-AI/Dormice';

// The production origin (canonical/OG/sitemap/robots). A plain constant, not
// an env var: the domain is decided and permanent, and requiring an env var
// would break the "root pnpm build needs no environment" invariant.
// scripts/generate-llms.mjs carries the same literal (it cannot import TS).
export const SITE_URL = 'https://dormice.dev';

export const SITE_TITLE = 'Dormice — the SQLite of agent sandboxes';

export const SITE_DESCRIPTION =
  'A self-hosted sandbox platform for AI agents. One machine, sandboxes ' +
  'that live forever, idle costs nothing.';
