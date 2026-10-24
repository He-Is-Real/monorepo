// Configuration read at request time from the environment that
// Terraform sets on the Cloud Run service (never baked into the image).
//
// D32: web server-renders from api-public-read only. It never calls api-user
// or api-admin, and holds no database access, secrets or tokens, so this is
// the only API address it gets. The story page that uses it is task 0.9.

export function apiPublicReadUrl(): string {
  const url = process.env['API_PUBLIC_READ_URL'];
  if (!url) {
    throw new Error(
      'API_PUBLIC_READ_URL is not set (the api-public-read base URL)',
    );
  }
  return url.replace(/\/+$/, '');
}

/**
 * The Clerk instance's publishable key (public, D32), or undefined when it isn't set: the site
 * then shows no sign-in control. Clerk itself runs in the browser only.
 */
export function clerkPublishableKey(): string | undefined {
  const key = process.env['CLERK_PUBLISHABLE_KEY']?.trim();
  if (!key) return undefined;
  if (!/^pk_(test|live)_[A-Za-z0-9]+$/.test(key)) {
    throw new Error(
      'CLERK_PUBLISHABLE_KEY is not a Clerk publishable key (pk_test_… or pk_live_…)',
    );
  }
  return key;
}

/**
 * Whether search engines are told not to index this deployment (`X-Robots-Tag` and a robots
 * meta tag). Fails closed: it's noindex unless indexing is explicitly allowed (see
 * `indexingAllowed`). The old `ROBOTS_NOINDEX` variable is no longer read.
 */
export function robotsNoindex(): boolean {
  return !indexingAllowed();
}

// A DNS name: labels of letters, digits and inner hyphens, ending in a top-level label that
// starts with a letter (so no numeric-only hosts). OpenTofu's `web_site_url` validation uses
// the same rule (https only, no port), so anything it accepts is accepted here.
const DNS_NAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function validOrigin(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.origin !== raw) return false; // a path, query, credentials, or a normalised host
  const host = url.hostname;
  return (
    host.length <= 253 &&
    (DNS_NAME.test(host) || IPV4.test(host) || host === 'localhost')
  );
}

/**
 * The site's public origin (`SITE_URL`, set by OpenTofu: `web_site_url`), without a trailing
 * slash, or undefined when unset. Canonical URLs, Open Graph, JSON-LD, robots.txt and the
 * sitemap are built from it; it never comes from the visitor's request (D32). A malformed value
 * is logged and treated as unset (no absolute URLs, no indexing), so it can't take pages down.
 */
export function siteUrl(): string | undefined {
  const raw = process.env['SITE_URL']?.trim().replace(/\/+$/, '');
  if (!raw) return undefined;
  if (validOrigin(raw)) return raw;
  console.error(
    'SITE_URL is not an http(s) origin without a path (e.g. https://www.heisreal.today); ignoring it',
  );
  return undefined;
}

/**
 * Whether search engines are invited in: no noindex, robots.txt allows crawling and lists the
 * sitemap, and /sitemap.xml exists. An explicit opt-in: `INDEXING=allow` exactly (OpenTofu:
 * `web_indexing`, refused in dev) and a valid site URL. Anything else, including a missing
 * or misspelled value, keeps the site out of search engines.
 */
export function indexingAllowed(): boolean {
  return process.env['INDEXING'] === 'allow' && siteUrl() !== undefined;
}
