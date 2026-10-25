# API conventions

How the APIs are shaped and built. The contracts in [`libs/contracts/openapi`](../libs/contracts)
are the source of truth (D23): change the spec in the same PR as the code. The reasoning behind
each rule is in `project/context/research/m0-schema-consent-decisions.html` (decision numbers in
brackets).

## Services and who calls them (D31–D33, D35)

| Service           | Serves                                                                                                                                                | Auth                                | In the database                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| `api-public-read` | Anonymous public queries: published stories, tags, published DPA versions                                                                             | None                                | Its own login; sees only public tables           |
| `api-user`        | **Everything that needs to know who you are**: own stories, account, consents, favourites, feed, and the person's commands; Clerk and Stripe webhooks | Clerk JWT (webhooks: signature)     | Runs as the person, with their Clerk token (D27) |
| `api-admin`       | Moderation, roles, tags, DPA versions                                                                                                                 | Clerk JWT, role Moderator or higher | Its own login                                    |

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
- **The account bootstrap:** web's header calls `GET /v1/account` once each time a page loads
  signed in. The first call creates the person's `user` row (so staff can use `api-admin`), and
  `signupConsent.accepted` says whether the sign-up form still needs accepting (D73). Its
  failure blocks nothing.
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
- No event store or event sourcing. The consent ledger and `auditLog` are the append-only logs.
- Test every command against the read models it updates.

## Read models (D26)

- **`publicStory` is the only read model.** It holds approved stories only: slug, `slugHistory`,
  title, description/body, byline, tag links, playback fields, published date and the search text.
  Never the submitter, consent, raw transcript, moderation data or quality signal.
- Approve creates it; editing an approved story updates it; withdrawal, erasure and withdrawing
  `publish` or Art 9 consent delete it, in the same transaction. Tag renames need nothing (tags are
  fetched by reference, D15).
- **Anonymous queries read only read models** (and reference data: `tag`, published `dpaVersion`).
  Personal queries read the person's own rows in the write tables, as the person. Moderation reads
  the `story` write model on `api-admin`.
- `publicStory` holds Art 9 data: it is on the erasure checklist.

## Commands and CRUD (D28)

| Kind                                                | Style                                                                                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain resource (no lifecycle, no side effects)      | CRUD: `POST` creates, `GET`, `PATCH` with JSON Merge Patch (`application/merge-patch+json`) on editable fields only, `DELETE`. Relationships use idempotent `PUT`/`DELETE`. |
| State change (lifecycle, side effects, permissions) | One named command per intent: `POST /v1/<resource>/{id}/<verb>`. **Never `PATCH` a status.**                                                                                |

**What a command returns:** `{ id, version }` and nothing from the read model. Creates answer `201`
with `Location` (when the resource can be read); work that continues asynchronously (erasure,
consent withdrawal) answers `202`. `version` is `null` only where the target has none (consent
ledger events, and what Clerk holds: roles and account settings). The one exception is `/upload-url`, which also returns
short-lived upload credentials.

**Naming rules:**

- Collections are plural nouns (`/stories`, `/tags`, `/consents`, `/concerns`); the method says
  what happens. Singletons are singular (`/account`, `/feed`, `/moderation/queue`).
- A verb only as the last segment of a state-changing `POST` that isn't create/replace/delete:
  `/submit`, `/withdraw`, `/approve`, `/reject`, `/request-changes`, `/escalate`, `/lock`,
  `/release`, `/assign-role`, `/publish`. Never a verb in a `GET`, never `/getStories`.
- The person's relationships live under `/account` by the related item's ID, with `PUT`/`DELETE`:
  `/account/favourites/{storyId}`, `/account/helped/{storyId}`.
- kebab-case path segments, camelCase JSON, opaque IDs. Keep `/{id}/verb` (Google's `/{id}:verb`
  clashes with Express route parameters).

## Concurrency and idempotency (D29)

- **Versions:** every aggregate (story, tag, dpaVersion) has a `version`
  integer, +1 on every command. A query for one resource returns it as a strong
  `ETag: "<version>"`.
- **Collections** (lists, pages, composite views such as consent state) and resources without a
  database version (the account) return a **weak, representation-based `ETag`** (`W/"<hash>"`).
  It is only for `If-None-Match`/`304`; to modify an item, use that item's `version`.
- **Public reads that embed other resources** (api-public-read's story, with its tags by
  reference) return a **strong hash of the response body** (`RepresentationETag`), not the
  version: renaming a tag changes the story's JSON but not its version (#45 review). Public reads
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
  - Appends to the consent ledger (grant, withdraw): nothing to conflict with.
  - `DELETE /v1/account` (`EraseAccount`): erasure must always succeed, whatever the person's
    data looks like at that moment, and there is no single version across everything it deletes.
  - `PUT`/`DELETE /v1/account/favourites/{storyId}` and `/v1/account/helped/{storyId}`: unversioned
    relationships that either exist or don't. The methods are idempotent, and repeating one gives the
    same result, so there is no lost update to prevent.
- **`Idempotency-Key` is required on non-idempotent `POST`s:** create draft, submit, grant and
  withdraw consent, concerns, and donations later. The `idempotencyKey` table stores key + user +
  request hash + the `{ id, version }` response for 24 hours (pruned nightly). A retry with the same
  body replays the stored response; the same key with a different body → `422`; no key → `400`.
- Not needed on idempotent methods (`PUT`, `DELETE`) or on creates with a natural key (tags, DPA
  versions), where a repeat gets `409`.
- **Webhooks** deduplicate on the provider's event ID (`svix-id`, Stripe `event.id`) in the same
  table, and acknowledge duplicates without applying them again.

## HTTP conventions (D30)

- **Versioning:** every path starts with `/v1`, except `/health`. It matters from M8, when embedded
  widgets on church websites can't be updated in lockstep.
- **Errors:** RFC 9457 `application/problem+json`: `type`, `title`, `status`, `detail`, plus our
  `code` and `errors[]` (`pointer`, `message`) for field errors. **Never echo testimony text or other
  personal data in an error.**

  | Status | When                                                                                                                  |
  | ------ | --------------------------------------------------------------------------------------------------------------------- |
  | 400    | Malformed or invalid request; missing `Idempotency-Key`                                                               |
  | 401    | Missing or invalid Clerk token                                                                                        |
  | 403    | Role, ownership or consent check failed                                                                               |
  | 404    | Not found, or not visible to the caller                                                                               |
  | 409    | The resource's state doesn't allow it (not a draft, locked, in use)                                                   |
  | 412    | `If-Match` doesn't match the current version                                                                          |
  | 422    | `Idempotency-Key` reused with a different body                                                                        |
  | 428    | `If-Match` missing                                                                                                    |
  | 5XX    | The service couldn't answer (e.g. the database is down): a bare `title` and `status`, never the cause (`ServerError`) |

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

## Consent on routes (D21)

- `libs/consent` provides `@RequiresConsent({ subject, types })` and `@NoConsentRequired(reason)`,
  on the handler or its controller. **Every `api-user` and `api-admin` route carries exactly one of
  them** (the health probe too). Fail closed, three times over: the global `ConsentGuard`
  (`ConsentModule.forRoot()`) answers `500` for a route with neither or both, the application refuses
  to start with one, and each app's `routes.spec.ts` lists every registered route with its policy.
- Use the named requirements in `CONSENT_REQUIRED` (`createDraft`, `editDraft`, `requestUpload`,
  `submitStory`, `approveStory`) rather than spelling types out. Missing consent is `403` with
  `code: consent_required`; no sign-in is `401`.
- The check is the database's `fn::consent::granted`, read at that moment: `caller` in the person's
  own session, `submitter` (the story in the `id` route parameter) on the service's login, which only
  api-admin can use (on api-user's login it always fails closed). The database's events enforce the
  same rules on every write; the guard refuses early and makes each route state its choice.
- The specs mark guarded routes with `x-requires-consent: { subject, types }`: `subject: caller`
  checks the signed-in person, `subject: submitter` the story's submitter.
- **No testimony content is stored without current Art 9 consent** (plan task 2.3: consent comes
  before "create draft story"):

  | Route                                                       | Needs                                                              |
  | ----------------------------------------------------------- | ------------------------------------------------------------------ |
  | Create a draft, edit it, request an upload URL (`api-user`) | The caller's `special_category_religious`                          |
  | `POST /v1/stories/{id}/submit` (`api-user`)                 | The caller's `special_category_religious`, `publish`, `age_18plus` |
  | `POST /v1/moderation/stories/{id}/approve` (`api-admin`)    | The same three, for the story's submitter                          |

- Request bodies never carry consent. It stays in the person's ledger, granted through
  `POST /v1/account/consents`, and is checked, not carried.
- Consent is per person and read from the ledger at that moment (D17, D18): no cached copy. A stored
  story is only processed (approved, transcribed) after a fresh ledger check, not just the one at
  submission. That includes the M7 workers.

## Writing to the database (D13, D27)

- A person's own commands run in a database session **as that person**, opened with their Clerk
  token, so the database enforces ownership. Admin commands run as `api-admin`'s login. In code:
  `PersonSessions.run(request, ({ session, user }) => …)` (`libs/consent`), built on
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

| Extension            | Meaning                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `x-required-role`    | Minimum Clerk role (`User`, `Moderator`, `Admin`, `SuperAdmin`); D1           |
| `x-requires-consent` | The route has `@RequiresConsent`; `subject` and the consent `types` it checks |
| `x-milestone`        | The delivery milestone that builds the operation (`M0`–`M8`); lint-enforced   |

`pnpm nx run contracts:lint-openapi` lints the specs (Redocly, recommended-strict); it also runs as
part of `lint`, so CI checks it on every PR that touches them.
