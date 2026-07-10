import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';

// With output: 'export' this route is evaluated once at build time and the
// whole search index lands in out/ as a static file; the search dialog
// downloads it and queries client-side (components/search.tsx).
export const revalidate = false;
export const { staticGET: GET } = createFromSource(source);
