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
 * The story the home page shows (0.9: the dev seed's test story), or undefined. Set by
 * Terraform per environment; browse arrives in M1.
 */
export function featuredStorySlug(): string | undefined {
  const slug = process.env['FEATURED_STORY_SLUG']?.trim();
  return slug ? slug : undefined;
}

/**
 * Whether search engines are told not to index this deployment (`X-Robots-Tag` and a robots
 * meta tag). Terraform turns it on in dev: the site is public but not real yet.
 */
export function robotsNoindex(): boolean {
  return process.env['ROBOTS_NOINDEX'] === 'true';
}
