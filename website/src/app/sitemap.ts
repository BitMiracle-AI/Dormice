import type { MetadataRoute } from 'next';
import { docs } from '@/lib/docs';
import { SITE_URL } from '@/lib/site';

// Driven by the docs registry: a new page in meta.json lands in the sitemap
// with no change here. Emitted as out/sitemap.xml at build time —
// output:'export' requires the route to declare itself static.
export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/` },
    ...docs.map((entry) => ({ url: `${SITE_URL}${entry.href}` })),
  ];
}
