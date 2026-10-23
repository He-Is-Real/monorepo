# M1 step 6b-2: static pages, SEO and cookie notice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the M1 static pages (delivery plan 1.5), per-page SEO plus a sitemap and robots.txt that keep dev non-indexed (1.6/1.7), and the minimum lawful cookie/storage notice (1.8), with the site footer that links them.

**Architecture:** Server-rendered App Router pages in `apps/web/src/app/<route>/page.tsx`, each exporting `metadata` built by one helper (`pageMetadata`) so canonical, Open Graph and Twitter stay consistent. One switch, the existing `ROBOTS_NOINDEX` (decision 21, `web_noindex` in OpenTofu), drives the header and meta tag (as today) and now robots.txt and the sitemap too. A new optional `SITE_URL` (`web_site_url`) gives absolute URLs. The sitemap is a route handler that pages through api-public-read's `GET /v1/stories` (D32: server-side, nothing from the visitor).

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4 tokens (`global.css`), Jest + Testing Library, Playwright device matrix (`apps/web/e2e`), OpenTofu (`infra/terraform/modules/gcp/web.tf`).

**Spec:** the step 6b-2 brief (coordinator, 2026-10-23); mockups `project/context/future/design/public/{about,greatest-story,get-ready,next-steps,faqs,contact}.html` and `home.html`'s footer; copy `project/context/future/content/*.md`; `design/accessibility-audit.md`; `architecture/gdpr-consent.md`; delivery plan M1 1.5–1.8.

## Global Constraints

- Mobile-first 320 px → 2560 px: no horizontal scroll, touch targets ≥ 44 px, `max-w-prose` text, safe areas (AGENTS.md, decision 20). Every new page in `apps/web/e2e`, light and dark, all 16 devices.
- Routes (agreed with 6b-1): `/about`, `/greatest-story`, `/get-ready`, `/next-steps`, `/faqs`, `/contact`, `/privacy`, `/terms`; browse is `/stories`, stories `/stories/[slug]`. 6b-1 owns the header and `/donate`; this step owns the footer, `siteUrl()`, robots, sitemap and site-wide metadata.
- Dev stays non-indexed: with `ROBOTS_NOINDEX=true`, robots.txt is `Disallow: /` with no `Sitemap:` line, and `/sitemap.xml` answers `404`. Indexing is the same switch turned off at Go live (plus `web_site_url` set to the real domain).
- No third-party iframes, scripts, trackers or consent SDKs; no iframe loads without a click. No personal data collected (no contact form backend: no form fields at all).
- Copy is the mockups' and content specs', warm and short. Changes only where a recorded decision or the consent model requires them (listed in the PR).
- Title template stays `%s | He Is Real Today` (existing layout).
- No canonical in the root layout (children would inherit it); every page sets its own.

## Review Focus

- **API down while building the sitemap:** answer `503` with `Retry-After`, never a partial sitemap that silently drops stories. Test in Task 3.
- **A runaway cursor loop** (API keeps returning a `nextCursor`): stop at 50,000 URLs (the sitemap protocol limit). Test in Task 3.
- **Indexing on but `SITE_URL` unset:** robots.txt and sitemap can't produce absolute URLs; they fall back to the noindex answers rather than emit `localhost`. Test in Tasks 1 and 3.
- **Slugs or titles with XML-special characters** in the sitemap: escaped. Test in Task 3.
- **FAQ accordion without JavaScript / for search engines:** every answer is in the server HTML (collapsed panels use `hidden`, not removed). Test in Task 5.

---

### Task 1: Site config, SEO helper, root metadata and JSON-LD

**Files:**

- Modify: `apps/web/src/lib/config.ts`, `apps/web/src/lib/config.spec.ts`
- Create: `apps/web/src/lib/seo.ts`, `apps/web/src/lib/seo.spec.ts`, `apps/web/src/lib/site-pages.ts`
- Create: `apps/web/src/app/opengraph-image.png` (1200×630, logo on the dark background; rendered once from HTML with Playwright), `apps/web/public/logo.png` (512 px, for JSON-LD `logo`)
- Modify: `apps/web/src/app/layout.tsx`, `apps/web/src/app/layout.spec.tsx`
- Modify: `infra/terraform/modules/gcp/web.tf`, `variables.tf`; `infra/terraform/live/dev/gcp/main.tf`

**Interfaces:**

- Produces: `siteUrl(): string | undefined` (config.ts: `SITE_URL`, trailing slashes stripped, must parse as an `http:`/`https:` origin without path, else throws; unset → undefined). `indexingAllowed(): boolean` = `!robotsNoindex() && siteUrl() !== undefined`.
- Produces: `SITE_NAME = 'He Is Real Today'`, `SITE_DESCRIPTION`, `pageMetadata({ title, description, path, images? }): Metadata` (seo.ts) → `{ title, description, alternates: { canonical: path }, openGraph: { ...OG_DEFAULTS, title, description, url: path, images? }, twitter: { card: 'summary_large_image', title, description, images? } }`. `siteJsonLd(origin: string): object[]` → Organization + WebSite. `jsonLdScript(data: unknown): string` → JSON with `<` escaped as `<`.
- Produces: `STATIC_PAGES: { path: string; changeFrequency: 'monthly' | 'yearly' }[]` (site-pages.ts) — `/`, `/stories`, the eight pages.

- [ ] Tests (config.spec): `siteUrl` strips `/`, returns undefined when unset/blank, throws on `ftp://x`, on `https://x/path`; `indexingAllowed` false when noindex, false without SITE_URL, true with both right.
- [ ] Tests (seo.spec): `pageMetadata` sets canonical to the path and keeps `siteName`/`locale: 'en_GB'`/`type: 'website'` in openGraph; `jsonLdScript('</script>')` contains no `</`; `siteJsonLd('https://x')` has `@type` Organization with `url: 'https://x'`, `logo: 'https://x/logo.png'` and WebSite.
- [ ] Tests (layout.spec): `generateMetadata()` has `metadataBase` = `new URL(SITE_URL)` when set and none when unset; OG/Twitter defaults; no `alternates`; the body contains one `application/ld+json` script when SITE_URL is set.
- [ ] Implement; OpenTofu: `web_site_url` (string, default `""`, validation: empty or `https://` origin without path), env `SITE_URL`, dev = `https://web-jbxp6odnsa-nw.a.run.app`. Run `tofu fmt` via `tools/scripts/tf.sh` conventions or `tofu fmt -check`.
- [ ] `pnpm nx test web`, commit.

### Task 2: robots.txt

**Files:** Create `apps/web/src/app/robots.ts`, `robots.spec.ts`.

**Interfaces:** Consumes `indexingAllowed`, `siteUrl`. Produces `default function robots(): MetadataRoute.Robots` with `export const dynamic = 'force-dynamic'` (env read per request, not at build).

- [ ] Tests: noindex → `{ rules: { userAgent: '*', disallow: '/' } }` and no `sitemap`; indexing on → `allow: '/'`, `disallow: ['/health']`, `sitemap: 'https://x/sitemap.xml'`, `host` omitted; indexing "on" without SITE_URL → disallow-all.
- [ ] Implement, run, commit.

### Task 3: sitemap.xml

**Files:** Create `apps/web/src/lib/sitemap.ts` (+ spec), `apps/web/src/app/sitemap.xml/route.ts` (+ spec).

**Interfaces:**

- Consumes: `browseStories({ sort: 'latest', limit: 50, cursor })` from `lib/browse.ts`, `STATIC_PAGES`, `indexingAllowed`, `siteUrl`.
- Produces: `collectStoryEntries(fetchPage = browseStories): Promise<{ slug: string; publishedAt: string }[]>` (stops at `nextCursor === null` or `MAX_URLS = 50_000` total URLs including static pages); `renderSitemap(origin: string, entries): string` (urlset, `<loc>`, `<lastmod>` = publishedAt date for stories; XML-escaped).
- Route `GET`: `force-dynamic`; noindex or no SITE_URL → `404` (plain text); API error (`StoriesUnavailableError`) → `503`, `Retry-After: 300`; else `200`, `application/xml; charset=utf-8`, `Cache-Control: no-store` (D51: a withdrawn story's URL must not linger; front-door caching is D56's).

- [ ] Tests: pagination follows cursors over 3 pages; cap stops a loop that never ends; escaping of `&<>"'`; route returns 404 in noindex, 404 without SITE_URL, 503 when fetch throws, 200 XML with static pages + `/stories/<slug>`.
- [ ] Extend `e2e/stub-api.mjs` with `GET /v1/stories` (two pages of summaries) for the e2e checks.
- [ ] Implement, run, commit.

### Task 4: Footer with the cookie/storage notice

**Files:** Modify `apps/web/src/components/site-footer.tsx`, `site-footer.spec.tsx`.

Layout from `home.html`'s footer, mobile-first: brand blurb ("A collection of God Stories from everyday people around the world. Not affiliated with any particular Christian denomination." + "UK-based not-for-profit. Charity registration pending."); nav `aria-label="Footer"` with Explore (Browse stories `/stories`, About us, Greatest Story, FAQs) and Share (Get ready to share, Next steps, Contact us); bottom row: `© 2026 He Is Real Today.`, Privacy policy, Terms, and the notice "We only use essential cookies and storage. [How we use them]" → `/privacy#cookies`. The D48 note stays (shown only when relaxed). Omitted from the mockup: Impact (M5), Share your story (M2), social links (no URLs), Sharing Principles (no page). Every link ≥ 44 px tall.

- [ ] Tests: footer always renders (not null when consent is strict) with a `contentinfo` landmark; the links and hrefs above; notice links to `/privacy#cookies`; D48 note only when relaxed.
- [ ] Implement, run, commit.

### Task 5: Shared page pieces + FAQs (accordion)

**Files:** Create `apps/web/src/components/page/page-header.tsx` (eyebrow, `h1`, lead; centred), `apps/web/src/components/page/cta-link.tsx` (`Link` styled as primary/secondary button, `min-h-11`), `apps/web/src/components/faq/faq-accordion.tsx` (client) + spec, `apps/web/src/lib/faqs.ts` (data), `apps/web/src/app/faqs/page.tsx` + spec.

Accordion = WAI-ARIA accordion pattern: each question is `<h3><button aria-expanded aria-controls id>`; panel `role="region" aria-labelledby`, `hidden` when collapsed; all collapsed at first; each toggles independently. FAQ copy from `faqs.html`, corrected to the consent model: socials are a separate choice (`share_socials`), the anonymous byline matches the site's, no promises of email notifications. Groups are `h2`. Also FAQPage JSON-LD from the same data. Description includes "Is God real?".

- [ ] Tests: buttons start `aria-expanded="false"`, click and Enter/Space expand, answers present in server markup, JSON-LD lists every question.
- [ ] Implement, run, commit.

### Task 6: About, Next Steps, Get Ready, Contact

**Files:** `apps/web/src/app/{about,next-steps,get-ready,contact}/page.tsx` + one spec each.

- About: header "The heart behind He Is Real" (h1), founder video placeholder ("Founder's introduction — coming soon", no iframe: the video isn't recorded; when it is, it goes through api-public-read's signed links, D52), mission (blockquote), three values (lucide icons, `aria-hidden`), CTA → `/get-ready`, `/contact`.
- Next Steps: three cards; Alpha → `https://alpha.org/`, church → `https://www.achurchnearyou.com/` (content spec's example; question for Joel), message → `/contact`. External links show their domain, `rel="noreferrer"`.
- Get Ready: resources show "Coming soon" instead of PDF/audio links (no files yet); explainer video card "Coming soon"; four tips; CTA "Ready?" says sharing opens soon (no `/submit` in M1) with a link to `/faqs`.
- Contact: header, a card: "Our contact form is coming soon. For now, email us and a real person will reply." + `mailto:info@heisreal.today` button; no form fields (no backend, no privacy basis yet).
- [ ] Tests: each page's h1, key links/hrefs, metadata canonical; About has no iframe; Contact has no `input`/`textarea`.
- [ ] Implement, run, commit.

### Task 7: Greatest Story, Privacy, Terms

**Files:** `apps/web/src/app/greatest-story/page.tsx` + spec, `apps/web/src/components/greatest-story/illustrations.tsx` (the mockup's five SVGs, `aria-hidden`, `currentColor` teal), `apps/web/src/app/{privacy,terms}/page.tsx` + specs, `apps/web/src/components/page/draft-notice.tsx`.

- Greatest Story: hero h1 "The Greatest Story Ever Told", six numbered `h2` sections (text first in the DOM; illustration alternates sides from `md`), verses as `blockquote` + `cite`, prayer card, "What now?" CTAs (`/next-steps`, `/stories`, `/contact`), NIV copyright notice (question for Joel: edition).
- Privacy: `DraftNotice` ("Draft — dev only. The real policy comes before the site goes live."), short who-we-are, and `#cookies`: the storage inventory table (theme; Clerk `__client_uat`, `__session`, `__clerk_db_jwt` dev only, `__clerk_environment`; Cloudflare `__cf_bm`/`_cfuvid` on Clerk's domain) and why no banner (all strictly necessary, PECR reg. 6(4)). Terms: `DraftNotice` + two placeholder paragraphs.
- [ ] Tests: headings, `#cookies` section exists, draft notice on both, NIV notice present.
- [ ] Implement, run, commit.

### Task 8: e2e, docs, verification, PR

**Files:** Create `apps/web/e2e/static-pages.e2e.ts`; modify `docs/delivery-status.md`, `apps/web/e2e/responsive.e2e.ts` only if the footer changes its expectations.

- [ ] e2e per page × device × scheme: 200, noindex header, h1, one `main`, `banner`/`contentinfo` landmarks, no horizontal overflow, CTA targets ≥ 44 px, screenshot. FAQ: keyboard (Tab to first question, Enter opens, `aria-expanded`). robots.txt is disallow-all and `/sitemap.xml` is 404 under `ROBOTS_NOINDEX=true`. No `iframe` on About.
- [ ] `pnpm nx run-many -t lint test build typecheck`, `pnpm nx e2e web`, `pnpm exec prettier --check`.
- [ ] delivery-status: step 6b-2 row, decision on cookies (no banner) and indexing switches.
- [ ] security-review skill on the diff; fix findings.
- [ ] PR with screenshots vs mockups; wait for CI.
