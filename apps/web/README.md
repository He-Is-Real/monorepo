# web

The Next.js site (App Router, Tailwind v4 + shadcn/ui). It server-renders from api-public-read
only, and Clerk runs in the browser only (D32, `docs/delivery-status.md`). Run it with
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
