// Site-wide constants, collected in one place so the layout metadata, the
// landing sections and the chrome never drift apart. Page-local copy stays
// in its section component; only text used from more than one place lives
// here. SITE_URL (canonical/OG/sitemap) is deliberately absent until the
// deployment target — GitHub Pages vs a domain — is decided.
export const GITHUB_URL = 'https://github.com/BitMiracle-AI/Dormice';

export const SITE_TITLE = 'Dormice — the SQLite of agent sandboxes';

export const SITE_DESCRIPTION =
  'A self-hosted sandbox platform for AI agents. One machine, sandboxes ' +
  'that live forever, idle costs nothing.';
