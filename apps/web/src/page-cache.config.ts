// How long the web server keeps a saved copy of each public page in its memory (Joel,
// 2026-11-21, page caching). One row per page, one column per environment (the web service's
// SITE_ENVIRONMENT, set by OpenTofu). Changing a time is an edit to this file, reviewed and merged
// like any change; the next deploy uses it.
//
// - a number: seconds. A saved copy is never served after its time, even when the refresh fails:
//   the visitor then gets the page as it renders now, with "try again later" if the API is down.
// - 'release': kept until the next release (a new deploy starts with nothing saved).
// - 'off': rendered fresh for every visit.
//
// Only the pages listed here can be cached, and only public pages may be listed: signed-in,
// staff, moderation, account, share, consent and sign-in pages never are (page-cache.ts refuses
// them, and its test checks this file). Single story pages aren't cached.

export const PAGE_CACHE = {
  // Pages that only change with a new release.
  '/faqs': { dev: 'release', prod: 'release' },
  '/greatest-story': { dev: 'release', prod: 'release' },
  '/get-ready': { dev: 'release', prod: 'release' },
  '/contact': { dev: 'release', prod: 'release' },
  // Its Stripe buttons are the deployment's settings: a new setting is a new deploy.
  '/donate': { dev: 'release', prod: 'release' },

  // Story search pages: home lists the newest stories.
  '/': { dev: 'off', prod: 30 },
  '/stories': { dev: 'off', prod: 30 },

  // Content admins can change: the founder's videos and the legal texts.
  '/about': { dev: 'off', prod: 30 },
  '/next-steps': { dev: 'off', prod: 30 },
  '/privacy': { dev: 'off', prod: 30 },
  '/privacy/versions/[number]': { dev: 'off', prod: 30 },
  '/terms': { dev: 'off', prod: 30 },
  '/terms/versions/[number]': { dev: 'off', prod: 30 },
} as const satisfies Record<
  string,
  Record<PageCacheEnvironment, PageCacheTime>
>;

export type PageCacheEnvironment = 'dev' | 'prod';
export type PageCacheTime = number | 'release' | 'off';
export type PageCachePath = keyof typeof PAGE_CACHE;
