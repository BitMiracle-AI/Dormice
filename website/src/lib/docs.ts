import type { MDXProps } from 'mdx/types';
import type { JSX } from 'react';
// Relative imports: content/ lives beside src/ on purpose — it is authored
// content, not source, and stays portable across doc-shell rewrites.
import * as architecture from '../../content/docs/architecture.mdx';
import * as configuration from '../../content/docs/configuration.mdx';
import * as e2bDifferences from '../../content/docs/e2b-differences.mdx';
import * as e2bSdks from '../../content/docs/e2b-sdks.mdx';
import * as indexDoc from '../../content/docs/index.mdx';
import * as installation from '../../content/docs/installation.mdx';
import * as lifecycle from '../../content/docs/lifecycle.mdx';
import meta from '../../content/docs/meta.json';
import * as persistence from '../../content/docs/persistence.mdx';
import * as quickstart from '../../content/docs/quickstart.mdx';

// Server-only registry of every doc. MDX renders as server components, so
// importing them all here costs the client nothing — pages ship as HTML.
// meta.json stays the single decision point for grouping and order; the
// assertions below fail the build when the two drift.

interface DocModule {
  frontmatter: { title: string; description: string };
  default: (props: MDXProps) => JSX.Element;
}

// meta.json name -> module ('index' is the /docs landing page, slug '').
const modules: Record<string, DocModule> = {
  index: indexDoc,
  installation,
  quickstart,
  lifecycle,
  persistence,
  architecture,
  'e2b-sdks': e2bSdks,
  'e2b-differences': e2bDifferences,
  configuration,
};

export interface DocEntry {
  /** URL path segments below /docs — empty string for the index page. */
  slug: string;
  href: string;
  title: string;
  description: string;
}

export interface DocGroup {
  title: string;
  entries: DocEntry[];
}

export const docGroups: DocGroup[] = meta.groups.map((group) => ({
  title: group.title,
  entries: group.pages.map((name) => {
    const mod = modules[name];
    if (!mod) {
      throw new Error(
        `content/docs/meta.json lists "${name}" but src/lib/docs.ts does not import it`,
      );
    }
    const slug = name === 'index' ? '' : name;
    return {
      slug,
      href: slug === '' ? '/docs' : `/docs/${slug}`,
      title: mod.frontmatter.title,
      description: mod.frontmatter.description,
    };
  }),
}));

// Flat, in sidebar order. Groups exist only in the sidebar — URLs stay flat
// and prev/next pagination walks straight across group boundaries.
export const docs: DocEntry[] = docGroups.flatMap((group) => group.entries);

for (const name of Object.keys(modules)) {
  if (!meta.groups.some((group) => group.pages.includes(name))) {
    throw new Error(
      `src/lib/docs.ts imports "${name}" but content/docs/meta.json does not list it`,
    );
  }
}

export interface Doc {
  entry: DocEntry;
  Content: DocModule['default'];
  prev: DocEntry | null;
  next: DocEntry | null;
}

export function getDoc(slugSegments: string[] | undefined): Doc | null {
  const slug = (slugSegments ?? []).join('/');
  const position = docs.findIndex((entry) => entry.slug === slug);
  if (position === -1) return null;
  const entry = docs[position];
  const name = slug === '' ? 'index' : slug;
  const mod = modules[name];
  if (!entry || !mod) return null;
  return {
    entry,
    Content: mod.default,
    prev: docs[position - 1] ?? null,
    next: docs[position + 1] ?? null,
  };
}
