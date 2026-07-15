import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

// Emitted as out/robots.txt at build time; output:'export' requires the
// route to declare itself static.
export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
