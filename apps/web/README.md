# web

The Next.js site (App Router, Tailwind v4 + shadcn/ui). It server-renders from api-public-read
only, and Clerk runs in the browser only (D32, `docs/how-the-app-works.md`). Run it with
`pnpm nx dev web` (copy `.env.example` to `.env.local`); the e2e device matrix is
`pnpm nx e2e web` (`e2e/`).

## The token boundary (D32) and its one carve-out

web's server never reads, logs, stores or forwards the visitor's cookies or tokens. Clerk's
session cookie reaches it incidentally (same origin) and is never touched. `eslint.config.mjs`
fails `lint` on the honest mistakes that would break this: `next/headers` and Clerk's server
SDKs (imported, `import()`ed or `require`d), any `.headers` or `.cookies` access, reading
`cookie`/`authorization`/`__session`/`__clerk_db_jwt` by name, and `fetch` options or headers
that aren't object literals or contain spreads. `eslint-token-boundary.test.mjs` pins each probe.
It is a guardrail, not a security boundary: code review is the other half.

**The carve-out (M2): `src/lib/api-user.ts`, web's browser-only client for api-user** (D31, D83).
The signed-in parts of pages call api-user from the browser with the person's own Clerk token,
so this file has to build request headers (`Authorization`, `If-Match`, `Idempotency-Key`) in a
`Headers` object and read response headers (`ETag`, `Location`). For this file only, the
`.headers` rule and the `fetch`-literal rules are off. Everything else stays on there: no
`next/headers` or Clerk server SDK, no `.cookies`, no reading tokens by name. What keeps it
browser only:

- it is a `'use client'` module, so server components can't call its functions;
- `apiUser()` throws when there is no `window`;
- web's server only hands it api-user's address (`API_USER_URL`, `src/lib/config.ts`), never a
  token; the token comes from Clerk's `getToken()` in the browser, on every call.

Code that needs api-user goes through this client, never its own `fetch`. Widening the carve-out
(another file, another rule) is a decision for review: record it here and in
`eslint-token-boundary.test.mjs`.

**The second carve-out (rate limiting, RL-8 A, Joel 2026-11-21; logging, LG-2 and LG-4 A, Joel
22–24 Nov 2026): `src/lib/visitor-address.ts`.** `proxy.ts` counts each visitor's page loads and
server actions in memory, by their IP address, and writes each request's wide event, so this one
file reads four request headers by name: the last `X-Forwarded-For` entry (the one Google's front
end appended), `User-Agent`, `traceparent` (the trace Google's front end gives the request) and
`Next-Router-Prefetch` (a prefetch isn't a search someone made). The three beyond the address
are approved additions to D32's list (LG-13b A, Joel 25 Nov 2026). Lint allows exactly
`<request>.headers.get('<one of these>')` there, and `<request>.headers.traceparent` for the
request `onRequestError` reports, and refuses every other `.headers` or `.cookies` use; all the
other rules stay on. They are never stored or forwarded; the address and user agent are plain on
the request's event (LG-2), and on a search event the address is only a search-key hash (LG-2g A). A visitor over a limit gets what a crash gives: the proxy
rewrites the request (same URL) to `src/app/something-went-wrong`, a page that fails to render, so
Next answers as for any crash: its status and headers, and the site's error page (`app/error.tsx`). A limited server action (a POST)
goes to a route handler there that fails instead (`action/route.ts`): route handlers never run
server actions, so it doesn't run, and web never has to read the request's headers (D32). Next's proxy calls a 127.x `HOSTNAME` "localhost",
which turns that rewrite into a loop back through the proxy; the image listens on 0.0.0.0, and so
does the e2e server with limits on.

web's server also holds one secret now: the website key (`WEBSITE_KEY`, put in the environment by
Cloud Run from Secret Manager), sent as `X-Website-Key` with its calls to api-public-read so they
share one large allowance there (`websiteKey()` in `src/lib/config.ts`). It is never logged or
sent anywhere else.

## Signing in

- The header's **Sign in** is a link to `/sign-in?redirect_url=<this page>`. The page mounts
  Clerk's `<SignIn withSignUp />` (Google and email, never Apple) and sends the person back to
  that page, if it is a path on this site (`src/lib/return-path.ts`); otherwise home.
  Clerk's look is set only through its `appearance` and `localization` settings
  (`src/components/auth/`): the site's colours, 44 px controls, and no Clerk h1 (the page's
  "Welcome" is the only one).
- After each signed-in page load the header calls api-user's account bootstrap,
  `GET /v1/account`, once (`src/components/auth/account-bootstrap.ts`). A failure blocks nothing.
- e2e has no network: `E2E_FIXTURES=true` puts stand-ins in place of Clerk's controls, and the
  signed-in fixture calls the stub api-user (`e2e/stub-api-user.mjs`) with a fixture token. The
  real Clerk (including the size of its controls), and signing in with a Clerk test user, are
  checked on dev (`apps/dev-seed/behavioural`).

## Agreements after sign-in (plan 4e)

- The header's bootstrap answer drives `src/components/consent/consent-prompts.tsx`, in the
  browser only: anyone who hasn't agreed to the latest terms of use (a new account, or the terms
  changed since) is sent to `/consent/terms?redirect_url=<this page>` (sign-in, the step itself,
  `/privacy` and `/terms` stay open). Someone on an older testimony consent sees a banner under the
  header leading to `/consent/testimony` (not on `/share`, which asks in the flow; someone who never
  agreed is asked before their first story). "Not now" lasts for the page load. A failed bootstrap
  blocks nothing.
- The steps read the latest version (and, when agreeing again, the version agreed before) from
  api-public-read on the server (`src/lib/legal.ts`) and show one word-level redline between them
  (`src/lib/redline.ts`, jsdiff) with the full text a click away. The box is the page's own, outside
  the text: first time "I am 18 or over and agree to the terms of use.", then "I agree to version N
  of …".
- Ticking agrees through api-user (`POST /v1/account/agreements/{agreement}` with the version
  shown). If a newer version was saved meanwhile, api-user answers `409` and the page shows it.
- The social media sharing box is optional, at the end of Share, for that story only; it sends the
  version shown with the submit (`409` if it changed).

## Personal parts of pages (hearts)

Clerk runs only in the header's account control, so that control publishes who is signed in to
`src/lib/personal-session.ts`, and the rest of the page reads it there (D83). Hearts
(`src/lib/favourites.ts`, `src/components/stories/heart-button.tsx`) render the same for
everyone on the server, in a fixed place and size, and fill in once the browser knows: one
`GET /v1/account/favourites?storyId=…` colours every card on the page. Everything in the store
belongs to the person signed in now: an answer that arrives after someone else signed in is
dropped. **Signed out, hearts are the device's own** (Joel, 2026-10-28;
`src/lib/device-hearts.ts`): kept in this browser's local storage (`heisreal:device-hearts`,
listed on /privacy) with no expiry, and nothing reaches our servers. "My favourites"
(`/favourites`; `/account/favourites` redirects there; in the header signed out, the account menu signed in) then lists them, its cards read by web's server
from api-public-read by id (`deviceHeartCards`, anonymous: no login, D83). Signed in, a press
refused because the latest terms aren't agreed keeps the heart on the device and goes to
`/consent/terms` (only from a press, so it can't loop). Device hearts never go into an account by
themselves: once signed in and agreed to the latest terms, `src/components/favourites/device-hearts-prompt.tsx`
asks "Add the N stories you hearted on this device to your account?" (Add / Not now), counting
the public ones from the anonymous card lookup: nothing reaches api-user before Add. Add saves
them like presses, through the per-story queue, and reports what really happened; the device's
list stays as it is, and what was added is marked so it isn't offered again. Every api-user call
from the hearts uses `personalApiUser`: a token is sent only if its `sub` is the person the
work started for (Clerk's `getToken()` answers for whoever is signed in when it resolves). The
e2e fixture tokens are shaped like session tokens for that reason (`e2e.<payload>.fixture`). In e2e each test can give its browser its own
stub session (localStorage `e2e-session`), so parallel tests never share hearts.

## Legal documents (plan 4e)

- `/privacy` and `/terms` read the document from api-public-read on the server, per request, and
  show the latest version in the site's own formatting, with its number and the earlier
  versions; `/privacy/versions/<n>` and `/terms/versions/<n>` show any version. If
  api-public-read can't answer, they say so.
- Every legal text (those pages, the agreement steps, the submit flow and the admin preview) goes
  through one renderer, `src/lib/markdown.ts` (markdown-it, raw HTML off, links only to https:,
  mailto: and this site): headings, lists, tables, links, bold and inline `code`.
- `/admin/consent` (Admins and Super Admins): one screen for the four texts (terms of use,
  testimony consent, social media sharing consent, privacy notice). Edit the next version in a
  plain text box, see the redline against the latest and a live preview, and save it after a
  confirmation. Versions are never edited or deleted. If another admin saved meanwhile, api-admin
  answers `409` and the page offers to reload. It calls api-admin from the browser through the
  same client as api-user (`src/lib/api-user.ts`, with `API_ADMIN_URL`), so the token boundary
  above is unchanged.
- `/admin/limits` (Admins): the submission limits in plain words with their units, pre-filled
  with the values in force; Save lists the changes and asks to confirm. If another admin saved
  meanwhile, api-admin answers `412` and the page asks to reload. The admin pages share one
  gate and link each other (`src/components/admin/admin-access.tsx`).

## Saved pages (page caching)

Cache Components is on (`next.config.js`). Public pages listed in `src/page-cache.config.ts` are
kept in each server's memory for their environment's time (`SITE_ENVIRONMENT`, set by OpenTofu;
unset means nothing is kept); `src/lib/page-cache.ts` refuses personal, staff and single-story
pages and never serves a copy past its time. Because Next.js streams a page's shell first,
request-time `notFound()` answers 200 with a `noindex` robots tag, and `redirect()` (an old story
slug) moves the browser in the page rather than with a 301 (Joel, 2026-11-21, PC-1 A). Rules:
`docs/product/behaviour/browse.md`, "How fresh public pages are" and REQ-BRW-041 and REQ-BRW-042.
