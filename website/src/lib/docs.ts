import type { MDXProps } from 'mdx/types';
import type { JSX } from 'react';
// Relative imports: content/ lives beside src/ on purpose — it is authored
// content, not source, and stays portable across doc-shell rewrites.
import * as e2bCompatibility from '../../content/docs/e2b-compatibility.mdx';
import * as indexDoc from '../../content/docs/index.mdx';
import * as installation from '../../content/docs/installation.mdx';
import meta from '../../content/docs/meta.json';
import * as quickstart from '../../content/docs/quickstart.mdx';

// Server-only registry of every doc. MDX renders as server components, so
// importing them all here costs the client nothing — pages ship as HTML.
// meta.json stays the single decision point for order; the assertions below
// fail the build when the two drift.

interface DocModule {
  frontmatter: { title: string; description: string };
  default: (props: MDXProps) => JSX.Element;
}

// meta.json name -> module ('index' is the /docs landing page, slug '').
const modules: Record<string, DocModule> = {
  index: indexDoc,
  installation,
  quickstart,
  'e2b-compatibility': e2bCompatibility,
};

export interface DocEntry {
  /** URL path segments below /docs — empty string for the index page. */
  slug: string;
  href: string;
  title: string;
  description: string;
}

export const docs: DocEntry[] = meta.pages.map((name) => {
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
});

for (const name of Object.keys(modules)) {
  if (!meta.pages.includes(name)) {
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
