/**
 * Every rate limit, in one table (RL-9 A, Joel 2026-11-21: "one limits file in the shared
 * library"). A group is a set of routes that share one count per caller; the services attach
 * groups to their controllers (each API's `app.module.ts`), and web's `proxy.ts` uses the
 * `web*` groups. Changing a number is a reviewed change and a deploy.
 *
 * Each running copy counts in its own memory (RL-6): with two copies a caller can get up to
 * twice a number, and a restart starts the counts again. Counts are a sliding window: a caller's
 * count covers the last `windowMs`, not a clock minute that resets (Joel, 2026-11-21).
 *
 * The numbers (RL-2, Joel 2026-11-21: "dont rate limit moderators or admins themselves when
 * authed but do rate limit unauthenticated requests strictly. General user and public rate
 * limits are fine"): the decision document's "recommendation now" column
 * (`project/context/research/rate-limiting.html`): website pages 600 a minute, everything else
 * as first proposed. Its token bucket for public reading (30 at once, then 2 a second) is 120 a
 * minute here. Signed-in staff aren't limited at all; api-admin counts only the requests it
 * refuses for sign-in (`staffRefused`).
 *
 * No imports: web's proxy reads this file too (`@heisreal/http/rate-limits`).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface RateLimit {
  /** Requests allowed per caller in any `windowMs`; the next one gets the generic error. */
  limit: number;
  windowMs: number;
}

export const RATE_LIMITS = {
  // Every service's GET /health, per address.
  health: { limit: 60, windowMs: MINUTE },

  // api-public-read. `publicReads`: per address (scripts calling it directly). `website`: web's
  // own server, which carries the website key, shares one large allowance (RL-8 A): one visitor's
  // page makes a few reads, and web already counts each visitor (`webPages`).
  publicReads: { limit: 120, windowMs: MINUTE },
  website: { limit: 3000, windowMs: MINUTE },

  // web (proxy.ts), per visitor address: page loads and server actions; the sitemap separately.
  // Static files (/_next/static, images, the icon) aren't counted.
  webPages: { limit: 600, windowMs: MINUTE },
  webSitemap: { limit: 2, windowMs: MINUTE },

  // api-user, per address.
  /** The account, own stories and limits, themes, the favourites list. */
  accountReads: { limit: 120, windowMs: MINUTE },
  /** Drafts (create, edit, submit, back to edit), agreeing, hearts. */
  accountWrites: { limit: 60, windowMs: MINUTE },
  /** Upload grants (`POST /v1/stories/{id}/upload-url`), on top of `accountWrites`. */
  uploadGrants: { limit: 20, windowMs: HOUR },
  /** "Download my data". */
  dataExport: { limit: 2, windowMs: HOUR },
  /** Deleting the account or a story: its own count, so a busy account can still delete. */
  deletion: { limit: 10, windowMs: MINUTE },
  /**
   * The browser's error reports (`POST /v1/error-reports`, LG-1c, LG-9a), anyone, signed in or
   * not: their own count, so reports after a bad spell never use up a person's saves. The same
   * number as `accountWrites`.
   */
  errorReports: { limit: 60, windowMs: MINUTE },

  // api-admin, per address: only requests it refuses for sign-in (not signed in, a refused
  // sign-in, or not staff) count, and an address over the limit gets the generic error before
  // sign-in is checked. A signed-in moderator or admin is never counted (RL-2).
  staffRefused: { limit: 10, windowMs: MINUTE },
} as const satisfies Record<string, RateLimit>;

export type RateLimitGroup = keyof typeof RATE_LIMITS;
