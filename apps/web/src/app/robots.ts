import type { MetadataRoute } from 'next';
import { connection } from 'next/server';
import { indexingAllowed, siteUrl } from '@/lib/config';

/**
 * robots.txt. Unless indexing is allowed (INDEXING=allow; never in dev) crawlers are turned away and offered no sitemap; the
 * X-Robots-Tag header and robots meta tag (decision 21) still say noindex for anything
 * reached another way. At Go live it allows everything but /health and lists the sitemap.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  // Per request (`connection()`), never at build time: the image is built once for every
  // environment, and the switch is the deployment's (OpenTofu: web_indexing, web_site_url).
  await connection();
  if (!indexingAllowed()) {
    return { rules: { userAgent: '*', disallow: '/' } };
  }
  return {
    rules: { userAgent: '*', allow: '/', disallow: '/health' },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
