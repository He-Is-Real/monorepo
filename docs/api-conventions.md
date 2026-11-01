# API conventions

How the APIs are shaped and built. The contracts in [`libs/contracts/openapi`](../libs/contracts)
are the source of truth (D23): change the spec in the same PR as the code. The reasoning behind
each rule is in `project/context/research/m0-schema-consent-decisions.html` (decision numbers in
brackets).

## Services and who calls them (D31–D33, D35)

| Service           | Serves                                                                                                                                                         | Auth                                | In the database                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| `api-public-read` | Anonymous public queries: published stories, themes and the four legal texts (terms of use, testimony consent, sharing consent, privacy notice), every version | None                                | Its own login; sees only public tables           |
| `api-user`        | **Everything that needs to know who you are**: own stories, account, agreements, favourites, feed, and the person's commands; Clerk and Stripe webhooks        | Clerk JWT (webhooks: signature)     | Runs as the person, with their Clerk token (D27) |
| `api-admin`       | Moderation, roles, themes, saving new versions of the four legal texts (plan 4e)                                                                               | Clerk JWT, role Moderator or higher | Its own login                                    |

- **Anything personal goes to `api-user`; anything public goes to `api-public-read`.**
  `api-public-read` has no auth code at all.
- **`web` calls only `api-public-read`, and only on the server, to prerender** pages for crawlers,
  share cards and a fast first load (D32). It never calls `api-user` or `api-admin`, and holds no
  database access, secrets or user tokens.
- **The browser calls `api-user` and `api-admin` directly** with the Clerk token (D31). Signed-in
  pages are browser-side components. Each API allows CORS from the `web` origin only.
- **web's one client for api-user is `apps/web/src/lib/api-user.ts`, browser only** (D83). It asks
  Clerk's `getToken()` on every call and sends the token in `Authorization` (no cookies), builds
  `If-Match` from a resource's `version` and takes the caller's `Idempotency-Key` (keep the key
  and reuse it when retrying the same command), and turns every non-2xx answer into an
  `ApiUserProblem` carrying the RFC 9457 problem (`status`, `code`, `detail`, `errors`). A network
  failure or timeout is `ApiUserUnavailable`; no session means no request (`NotSignedIn`). It is
  the only file D32's lint guardrail lets build request headers and read response headers
  (`apps/web/README.md`). web's server only hands it api-user's address (`API_USER_URL`).
- **How `412` and `428` surface:** `412` is a `StaleVersion`: the resource changed since the page
  read it. Re-read it, re-apply the change if nothing it touched has changed, and ask the person
  only on a real clash (D70). `428` means our code forgot `If-Match`: a bug, logged in the
  browser console, never shown to the person as their mistake.
- **Hearts (M2):** web's browser asks `GET /v1/account/favourites?storyId=…` once for a page of
  cards ("which of these are mine?", up to 50 ids), so web's server never needs to know who is
  looking (D83). Hearts are private: no route answers anyone's hearts but the caller's, and no
  route gives counts. Signed out, hearts stay in the browser (Joel, 2026-10-28); their cards
  come from api-public-read's anonymous `GET /v1/stories?id=…` (up to 50 ids), through web's
  server like every other card.
- **The account bootstrap:** web's header calls `GET /v1/account` once each time a page loads
  signed in. The first call creates the person's `user` row (so staff can use `api-admin`), and
  `termsOfUse` and `testimonyConsent` say which version the person agreed to and whether it is the
  latest (plan 4e): not on the latest terms, the header takes them to the terms step. Its failure
  blocks nothing.
- Services never call each other. Async work goes out as CloudEvents on Pub/Sub to the worker
  tier (D34); the job payloads are in `worker.yaml`.
- This phase every service is reached at its generated `*.run.app` URL; no subdomains.

## CQRS-lite (D25)

- **Commands** (`api-user`, `api-admin`): one handler per intent (`SubmitStory`, `ApproveStory`,
  …). It validates, enforces the aggregate's rules, and writes in **one transaction that also
  updates every read model the change affects**, plus `auditLog` where relevant.
- **Queries**: query handlers with no side effects.
- A person sees their own change immediately: the client re-queries, and the read model is already
  current. There is no eventual consistency to handle in `web`.
- No event store or event sourcing. `auditLog` is the append-only log.
- Test every command against the read models it updates.

## Read models (D26)

- **`publicStory` is the only read model.** It holds approved stories only: slug, `slugHistory`,
  title, description/body, byline, theme links, playback fields, published date and the search text.
  Never the submitter, consent, raw transcript, moderation data or quality signal.
- Approve creates it; editing an approved story updates it; withdrawal and erasure (which is how a
  person withdraws their consent) delete it, in the same transaction. Theme renames need nothing (themes are
  fetched by reference, D15); deleting a theme removes it from every story and published story in
  the same transaction (`theme_delete` event).
- **Anonymous queries read only read models** (and reference data: `theme`, `themeCategory` and the four
  legal texts' versions).
  Personal queries read the person's own rows in the write tables, as the person. Moderation reads
  the `story` write model on `api-admin`.
- `publicStory` holds Art 9 data: it is on the erasure checklist.

## Commands and CRUD (D28)

| Kind                                                | Style                                                                                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain resource (no lifecycle, no side effects)      | CRUD: `POST` creates, `GET`, `PATCH` with JSON Merge Patch (`application/merge-patch+json`) on editable fields only, `DELETE`. Relationships use idempotent `PUT`/`DELETE`. |
| State change (lifecycle, side effects, permissions) | One named command per intent: `POST /v1/<resource>/{id}/<verb>`. **Never `PATCH` a status.**                                                                                |

**What a command returns:** `{ id, version }` and nothing from the read model. Creates answer `201`
with `Location` (when the resource can be read); work that continues asynchronously (erasure)
answers `202`. `version` is `null` only where the target has none (what Clerk holds: roles and
account settings). The one exception is `/upload-url`, which also returns
short-lived upload credentials.

**Naming rules:**

- Collections are plural nouns (`/stories`, `/themes`, `/concerns`); the method says
  what happens. Singletons are singular (`/account`, `/feed`, `/moderation/queue`).
- A verb only as the last segment of a state-changing `POST` that isn't create/replace/delete:
  `/submit`, `/withdraw`, `/approve`, `/reject`, `/request-changes`, `/escalate`, `/lock`,
  `/release`, `/assign-role`, `/publish`. Never a verb in a `GET`, never `/getStories`.
- The person's relationships live under `/account` by the related item's ID, with `PUT`/`DELETE`:
  `/account/favourites/{storyId}`, `/account/helped/{storyId}`.
- kebab-case path segments, camelCase JSON, opaque IDs. Keep `/{id}/verb` (Google's `/{id}:verb`
  clashes with Express route parameters).

## Concurrency and idempotency (D29)

- **Versions:** every aggregate (story) has a `version`
  integer, +1 on every command. Themes have one version for the whole set
  (`themeCatalog:current`), not one per theme: `PUT /v1/admin/themes` (`SaveThemes`) sends the
  finished picture with `If-Match` on it (`412`: "Someone else changed themes. Reload to see their
  changes"). A query for one resource returns it as a strong
  `ETag: "<version>"`.
- **Collections** (lists, pages, composite views such as the account) and resources without a
  database version (the account) return a **weak, representation-based `ETag`** (`W/"<hash>"`).
  It is only for `If-None-Match`/`304`; to modify an item, use that item's `version`.
- **Public reads that embed other resources** (api-public-read's story, with its themes by
  reference) return a **strong hash of the response body** (`RepresentationETag`), not the
  version: renaming a theme changes the story's JSON but not its version (#45 review). Public reads
  take no commands, so nothing sends these back in `If-Match`.
- **`If-Match` is required on commands that modify an existing resource.** Wrong version → `412`
  (re-read and retry); missing → `428`. This covers the real race: a submitter editing while a
  moderator approves.
- **Exceptions to `If-Match`**, each because there is no version to match, or nothing a stale
  client could overwrite:
  - `PATCH /v1/account` (not built in M2: no notification settings until emails, D79, D81):
    account settings (`notificationPrefs`) would live in Clerk `privateMetadata` (D16), written by
    `api-user` through Clerk's Backend API, and nothing is stored in SurrealDB. They are
    single-owner settings, so the last write wins. `version` is `null`.
  - `POST /v1/admin/users/{id}/assign-role`: the role lives in Clerk (D1).
  - `POST /v1/account/agreements/{agreement}`: the body names the version agreed to, and the
    database refuses one that is no longer the latest (`409 agreement_version_changed`); agreeing
    again to the same version changes nothing. No `Idempotency-Key` either.
  - `POST /v1/admin/legal-documents/{document}/versions`: the body names the version it saves as;
    the database refuses anything but the next number (`409 document_changed`).
  - `DELETE /v1/account` (`EraseAccount`): erasure must always succeed, whatever the person's
    data looks like at that moment, and there is no single version across everything it deletes.
  - `PUT`/`DELETE /v1/account/favourites/{storyId}` and `/v1/account/helped/{storyId}`: unversioned
    relationships that either exist or don't. The methods are idempotent, and repeating one gives the
    same result, so there is no lost update to prevent.
- **`Idempotency-Key` is required on non-idempotent `POST`s:** create draft, submit, request an
  upload (its grant counts against the person's upload limits), concerns, and donations later. The `idempotencyKey` table stores key + user +
  request hash + the `{ id, version }` response for 24 hours (pruned nightly). A retry with the same
  body replays the stored response; the same key with a different body → `422`; no key → `400`.
- Not needed on idempotent methods (`PUT`, `DELETE`) or on creates with a natural key (a legal
  text's next version), where a repeat gets `409`.
- **Webhooks** deduplicate on the provider's event ID (`svix-id`, Stripe `event.id`) in the same
  table, and acknowledge duplicates without applying them again.

## HTTP conventions (D30)

- **Versioning:** every path starts with `/v1`, except `/health`. It matters from M8, when embedded
  widgets on church websites can't be updated in lockstep.
- **Errors:** RFC 9457 `application/problem+json`: `type`, `title`, `status`, `detail`, plus our
  `code` and `errors[]` (`pointer`, `message`) for field errors. **Never echo testimony text or other
  personal data in an error.**

  | Status | When                                                                                                                      |
  | ------ | ------------------------------------------------------------------------------------------------------------------------- |
  | 400    | Malformed or invalid request; missing `Idempotency-Key`                                                                   |
  | 401    | Missing or invalid Clerk token                                                                                            |
  | 403    | Role or ownership check failed, or the person must agree first (`terms_agreement_required`, `testimony_consent_required`) |
  | 404    | Not found, or not visible to the caller                                                                                   |
  | 409    | The resource's state doesn't allow it (not a draft, locked, in use; `agreement_version_changed`, `document_changed`)      |
  | 412    | `If-Match` doesn't match the current version                                                                              |
  | 422    | `Idempotency-Key` reused with a different body                                                                            |
  | 428    | `If-Match` missing                                                                                                        |
  | 5XX    | The service couldn't answer (e.g. the database is down): a bare `title` and `status`, never the cause (`ServerError`)     |

  Contracts list every status an operation can answer, `5XX` included: api-public-read's
  integration tests and web's e2e stub are checked against the contract (`@heisreal/contracts/testing`).

- **IDs and slugs:** public queries use the slug (`GET /v1/stories/{slug}`); commands and admin
  routes use the ID. An old slug answers `301` to the current one (through `slugHistory`), so
  shared links survive a title edit.
- **Pagination:** cursors only. `?limit=&cursor=` → `{ data, nextCursor }`, `nextCursor: null` on
  the last page. No total counts, and no engagement metrics anywhere public.
- **Fields:** camelCase, RFC 3339 UTC timestamps, opaque IDs (record IDs without the table prefix;
  clients never parse them).
- **Caching:** public queries send `Cache-Control: no-store` until shared caching is turned on
  (`PUBLIC_RESPONSE_CACHING=on` on api-public-read; D51: never in dev; Go live decides, D56), then
  `public, max-age=60, stale-while-revalidate=300`. web fetches story data `no-store` too;
  personal and admin queries send `Cache-Control: private, no-store`. **Every query** returns an
  `ETag` (weak for collections, see above), accepts `If-None-Match`, and answers `304` with the same
  validator the `200` would carry (RFC 9110 §15.4.5).

## Agree first: the database's rule (plan 4e)

Joel's Q2 (2026-11-01): the database, not the routes, enforces "agree first". The per-route consent
decorators, the global consent guard and `x-requires-consent` are gone.

- A person agrees in their own session to the latest version of the terms of use (before using
  their account; it includes being 18 or over) and of the testimony consent (before their first
  story, and again before the next one when a newer version is saved). `POST
/v1/account/agreements/{agreement}` with `{ version }`: the page sends the version it showed.
  The social media sharing consent is optional, per story, and travels with the submission
  (`POST /v1/stories/{id}/submit`, `{ socialMediaSharingConsent: { version } }`); it can't be
  withdrawn. Nobody agrees to the privacy notice: it is linked beside every box.
- The database refuses the person's own writes until they have agreed, and its message starts
  with a code the API turns into a problem:

  | The person's write                                                 | Needs                                         | Refused as                                                    |
  | ------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------- |
  | Create, edit or submit a story; request an upload URL (`api-user`) | The latest terms of use and testimony consent | `403 terms_agreement_required` / `testimony_consent_required` |
  | Heart a story, `PUT /v1/account/favourites/{storyId}`              | The latest terms of use                       | `403 terms_agreement_required`                                |
  | Withdraw a story, delete a story or a heart, delete the account    | Nothing                                       |                                                               |
  | Agree, or tick sharing, on a version that is no longer the latest  | (refused)                                     | `409 agreement_version_changed`: the page shows what changed  |

- Approving (`api-admin`) and publishing need the submitter's testimony consent, any version: an
  older one still covers the stories it was given for.
- Request bodies carry only the version a page showed, never a consent decision for someone else:
  only the person's own session can set their agreements, and only to the latest version, with the
  database's time. Deleting the account is the withdrawal: their agreements go with it.
- The other codes (`agreement_not_own`, `agreement_time`, `agreement_kept`, `legal_version_kept`)
  mean a programming error: `500`.

## Writing to the database (D13, D27)

- A person's own commands run in a database session **as that person**, opened with their Clerk
  token, so the database enforces ownership. Admin commands run as `api-admin`'s login. In code:
  `PersonSessions.run(request, ({ session, user }) => …)` (`libs/auth`), built on
  `withPersonSession` (`libs/database`). Who the caller is comes from a `PersonAuthenticator`, the
  seam task 0.5 fills with Clerk verification; until then it refuses everyone (`401`).
- `Idempotency-Key`: `runIdempotent` (`libs/database`) writes the key, the request hash and the
  stored `{ id, version }` **in the same transaction as the command**, in the session the command
  runs in (a person may create and read only their own `api-user` keys). Either both commit or
  neither: a retry after a lost response replays, and of two requests racing with one key exactly one
  applies; the other replays its response, or gets `422` if its body differs. There is no "in flight"
  state to report, so no `409` for it.
- **A write the database permissions deny returns an empty result, not an error.** Every command
  handler must check that it really wrote the row(s) it meant to, and fail loudly otherwise (log it,
  and never answer `2xx`). The helper for this check is `requireWritten` in `libs/database`, with
  `runQuery` (root-cause errors) and `retryOnConflict` (retryable fence conflicts).
- Moderation pick-up hits RocksDB optimistic-transaction conflicts rather than blocking: retry the
  transaction.

## Spec extensions

| Extension         | Meaning                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `x-required-role` | Minimum Clerk role (`User`, `Moderator`, `Admin`, `SuperAdmin`); D1         |
| `x-milestone`     | The delivery milestone that builds the operation (`M0`–`M8`); lint-enforced |

`pnpm nx run contracts:lint-openapi` lints the specs (Redocly, recommended-strict); it also runs as
part of `lint`, so CI checks it on every PR that touches them.
