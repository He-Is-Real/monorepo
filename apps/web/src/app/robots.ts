import type { MetadataRoute } from 'next';
import { indexingAllowed, siteUrl } from '@/lib/config';

// Read per request: the image is built once for every environment, and the switch is the
// deployment's (OpenTofu: web_noindex, web_site_url).
export const dynamic = 'force-dynamic';

/**
 * robots.txt. In dev (ROBOTS_NOINDEX) crawlers are turned away and offered no sitemap; the
 * X-Robots-Tag header and robots meta tag (decision 21) still say noindex for anything
 * reached another way. At Go live it allows everything but /health and lists the sitemap.
 */
export default function robots(): MetadataRoute.Robots {
  if (!indexingAllowed()) {
    return { rules: { userAgent: '*', disallow: '/' } };
  }
  return {
    rules: { userAgent: '*', allow: '/', disallow: '/health' },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
