import { NextResponse } from 'next/server';
import { robotsNoindex } from '@/lib/config';

/**
 * Dev is public but not a real site yet: when ROBOTS_NOINDEX is on (Terraform, dev only),
 * every page and asset response tells search engines not to index or follow it (Next's own
 * trailing-slash redirects run before the proxy; they point at pages that carry it). The layout's robots meta tag
 * says the same for pages. This reads nothing from the request (D32).
 */
export function proxy() {
  return robotsNoindex()
    ? NextResponse.next({ headers: { 'X-Robots-Tag': 'noindex, nofollow' } })
    : NextResponse.next();
}

export const config = {
  // Every page and asset, including /health.
  matcher: '/:path*',
};
