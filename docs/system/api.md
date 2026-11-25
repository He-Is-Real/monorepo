# API

Covers: how the three APIs are split, shaped and built; what each route takes and answers is in the contracts.
Data: the OpenAPI specs in `libs/contracts/openapi` are the source of truth; the database rules are in [data-model.md](data-model.md).
Next id: REQ-API-092

## Contents

- Services and who calls them
- Routes with special handling
- Commands, queries and public reads
- Commands and CRUD
- Versions and If-Match
- Idempotency
- HTTP conventions
- Errors and rate limits
- Caching
- Agree first
- Writing to the database
- Spec extensions

## Services and who calls them

- **REQ-API-001** A change to an API changes its OpenAPI spec in `libs/contracts/openapi` in the same pull request as the code. [D23]
- **REQ-API-002** Each API serves exactly what the table below says. [D33]

| Service           | Serves                                                                                                                                                         | Auth                                | In the database                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| `api-public-read` | Anonymous public queries: published stories, themes and the four legal texts (terms of use, testimony consent, sharing consent, privacy notice), every version | None                                | Its own login; sees only public tables           |
| `api-user`        | Everything that needs to know who you are: own stories, account, agreements, favourites, feed, and the person's commands; Clerk and Stripe webhooks            | Clerk JWT (webhooks: signature)     | Runs as the person, with their Clerk token (D27) |
| `api-admin`       | Moderation, the staff list and roles, themes, saving new versions of the four legal texts                                                                      | Clerk JWT, role Moderator or higher | Its own login                                    |

- **REQ-API-003** Anything personal goes to `api-user` and anything public to `api-public-read`, which has no auth code at all. [D35]
- **REQ-API-004** `web` calls only `api-public-read`, and only on the server, to prerender pages for crawlers, share cards and a fast first load; it never calls `api-user` or `api-admin` and holds no database access or user tokens. [D32]
- **REQ-API-005** `web`'s one secret is the website key (REQ-API-068). [RL-8]
- **REQ-API-006** The browser calls `api-user` and `api-admin` directly with the Clerk token, signed-in pages are browser-side components, and each API allows CORS from the `web` origin only. [D31]
- **REQ-API-007** `web`'s one client for api-user is `apps/web/src/lib/api-user.ts`, browser only; it is the only file D32's lint guardrail lets build request headers and read response headers, and web's server only hands it api-user's address (`API_USER_URL`). [D83]
- **REQ-API-008** That client asks Clerk's `getToken()` on every call and sends the token in `Authorization`, never cookies. [D83]
- **REQ-API-009** That client builds `If-Match` from a resource's `version` and takes the caller's `Idempotency-Key`, which the caller keeps and reuses when retrying the same command. [D29]
- **REQ-API-010** That client turns every non-2xx answer into an `ApiUserProblem` carrying the RFC 9457 problem (`status`, `code`, `detail`, `errors`); a network failure or timeout is `ApiUserUnavailable`, and no session means no request (`NotSignedIn`). [D30]
- **REQ-API-011** On a `412` (`StaleVersion`), the page re-reads the resource, re-applies the change if nothing it touched has changed, and asks the person only on a real clash. [D70]
- **REQ-API-012** A `428` means our code forgot `If-Match`: a bug, logged in the browser console, never shown to the person as their mistake. [D29]
- **REQ-API-013** Services never call each other; async work goes out as CloudEvents on Pub/Sub to the worker tier, with the job payloads in `worker.yaml`. [D78]
- **REQ-API-014** This phase every service is reached at its generated `*.run.app` URL, with no subdomains. [D31]

## Routes with special handling

- **REQ-API-015** web's browser asks `GET /v1/account/favourites?storyId=…` (up to 50 ids) once for a page of cards, so web's server never needs to know who is looking. [D83]
- **REQ-API-016** No route answers anyone's hearts but the caller's, and no route gives heart counts. [R14]
- **REQ-API-017** Cards for hearts kept while signed out come from api-public-read's anonymous `GET /v1/stories?id=…` (up to 50 ids), through web's server like every other card. [D32]
- **REQ-API-018** The staff pages call api-admin's `GET /v1/moderation/stories` (`state`, `theme`, pages; drafts never sent Admin only) and `GET /v1/moderation/stories/{id}` (Moderator and up; a draft never sent Admin only). [MD-3]
- **REQ-API-019** The review answer signs the story's player and picture for one hour from that answer, so it carries a weak `ETag` of the answer itself, not the story's version. [C6]
- **REQ-API-020** Moderation decisions (`POST /v1/moderation/stories/{id}/approve`, `request-changes`, `reject`, `hide`, `show`) take the answer's `reviewTag` in `If-Match` instead of a version. [G14]
  Why: it stands for the newest status entry and the files shown, so work that only bumps the version doesn't refuse a decision.
- **REQ-API-021** An Admin's Delete (`DELETE /v1/moderation/stories/{id}`) takes no `If-Match` and deletes the story as it is now; it names nobody: no account id, and no user id on its status log. [DEL-3]
- **REQ-API-022** web's header calls `GET /v1/account` once each time a page loads signed in; the first call creates the person's `user` row, so staff can use `api-admin`. [J-2026-11-01-DB]
- **REQ-API-023** `GET /v1/account`'s `termsOfUse` and `testimonyConsent` say which version the person agreed to and whether it is the latest; its failure blocks nothing. [J-2026-11-01-DB]

## Commands, queries and public reads

- **REQ-API-024** A command (`api-user`, `api-admin`) is one handler per intent (`SubmitStory`, `ApproveStory`, …) that validates, enforces the aggregate's rules and writes in one transaction. [D25]
- **REQ-API-025** A story's status changes by adding an entry to its status log, which moves the story's pointer in the same write. [R6]
- **REQ-API-026** There is no audit log: a changeable setting names who changed it last (`changedBy`), and a legal text version who published it (`publishedBy`). [DB2-R3]
- **REQ-API-027** Query handlers have no side effects, and there is no event store or event sourcing. [D25]
- **REQ-API-028** A person sees their own change at once: the client re-queries and what it reads is already current, so `web` handles no eventual consistency. [D25]
- **REQ-API-029** Every command is tested against what it changes, on a real database. [D25]
- **REQ-API-030** The public reads the one `story` table like everyone else, and the database's rules decide what it sees: an approved story and only its published fields (REQ-DBS-007). [R11]
- **REQ-API-031** Approving publishes a story, Edit or a hide takes it off at once, and erasure deletes it with its status log: one write each, nothing to copy. [R11]
- **REQ-API-091** Renaming a theme needs no story write, since stories fetch themes by reference; deleting a theme removes it from every story in the same transaction (`theme_delete`). [D15]
- **REQ-API-032** Anonymous queries read only published stories and reference data (`theme`, `themeCategory`, the four legal texts' versions), and ask for approved stories themselves too. [D26]
- **REQ-API-033** Personal queries read the person's own rows, as the person; moderation and the Admins' story view read `story` on `api-admin`. [R15]
- **REQ-API-034** `story` and `storyStatusLog` hold Art 9 data and are on the erasure checklist. [D39]

## Commands and CRUD

- **REQ-API-035** Each kind of route takes the style in the table below. [D28]

| Kind                                                | Style                                                                                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain resource (no lifecycle, no side effects)      | CRUD: `POST` creates, `GET`, `PATCH` with JSON Merge Patch (`application/merge-patch+json`) on editable fields only, `DELETE`. Relationships use idempotent `PUT`/`DELETE`. |
| State change (lifecycle, side effects, permissions) | One named command per intent: `POST /v1/<resource>/{id}/<verb>`. Never `PATCH` a status.                                                                                    |

- **REQ-API-036** A command returns `{ id, version }` and nothing else about the resource; `version` is `null` only where the target has none (what Clerk holds: roles and account settings). [D28]
- **REQ-API-037** A create answers `201` with `Location` when the resource can be read; work that continues asynchronously (erasure) answers `202`. [D28]
- **REQ-API-038** The one exception to the command answer is `/upload-url`, which also returns short-lived upload credentials. [D80]
- **REQ-API-039** Collections are plural nouns (`/stories`, `/themes`, `/concerns`) and singletons singular (`/account`, `/feed`); the method says what happens. [D28]
- **REQ-API-040** A verb appears only as the last segment of a state-changing `POST` that isn't create, replace or delete (`/submit`, `/edit`, `/approve`, `/reject`, `/request-changes`, `/publish`); never in a `GET`, never `/getStories`. [D28]
- **REQ-API-041** The person's relationships live under `/account` by the related item's id, with `PUT`/`DELETE`: `/account/favourites/{storyId}`, `/account/helped/{storyId}`. [D28]
- **REQ-API-042** Paths use kebab-case segments and `/{id}/verb`, JSON uses camelCase, and ids are opaque. [D30]
  Why: Google's `/{id}:verb` clashes with Express route parameters.

## Versions and If-Match

- **REQ-API-043** Every aggregate (story) has a `version` integer, +1 on every command; a query for one resource returns it as a strong `ETag: "<version>"`. [D29]
- **REQ-API-044** Themes have one version for the whole set (`themeCatalog:current`): `PUT /v1/admin/themes` (`SaveThemes`) sends the finished set with `If-Match` on it, and a `412` reads "Someone else changed themes. Reload to see their changes". [A2]
- **REQ-API-045** Collections (lists, pages, composite views such as the account) and resources without a database version return a weak, representation-based `ETag` (`W/"<hash>"`), only for `If-None-Match`/`304`; an item is modified with that item's `version`. [D29]
- **REQ-API-046** Public reads that embed other resources (api-public-read's story, with its themes by reference) return a strong hash of the response body (`RepresentationETag`), not the version. [D29]
  Why: renaming a theme changes the story's JSON but not its version.
- **REQ-API-047** A command that modifies an existing resource requires `If-Match`: a wrong version answers `412`, a missing one `428`. [D29]
- **REQ-API-048** The routes in the table below take no `If-Match`, because there is no version to match or nothing a stale client could overwrite. [D29]

| Route                                                                           | Why no `If-Match`                                                                                                |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PATCH /v1/account` (planned)                                                   | Settings in Clerk `privateMetadata`, written by `api-user`, none in SurrealDB; last write wins; `version` `null` |
| `PUT`/`DELETE /v1/admin/staff/{email}`                                          | The role lives in Clerk                                                                                          |
| `POST /v1/account/agreements/{agreement}`                                       | The body names the version; no `Idempotency-Key` either                                                          |
| `POST /v1/admin/legal-documents/{document}/versions`                            | The body names the version it saves as                                                                           |
| `DELETE /v1/account` (`EraseAccount`)                                           | Erasure must always succeed; no single version across what it deletes                                            |
| `PUT`/`DELETE /v1/account/favourites/{storyId}`, `/v1/account/helped/{storyId}` | Unversioned relationships; the methods are idempotent                                                            |
| `PATCH /v1/admin/block-list/emails/{email}`, `/ips/{ip}`                        | An entry has no version; the later save wins; `version` `null`                                                   |

- **REQ-API-049** Agreeing again to the same version changes nothing, and the database refuses any version but the latest (`409 agreement_version_changed`). [J-2026-11-01-DB]
- **REQ-API-050** A legal text save is refused unless it is the next number (`409 document_changed`). [J-2026-11-01-DB]
- **REQ-API-051** A block-list note save records nobody as having changed it. [BN-4]

## Idempotency

- **REQ-API-052** Non-idempotent `POST`s require `Idempotency-Key`: create draft, submit, request an upload (its file row counts against the person's upload limits), concerns, and donations. [D29]
- **REQ-API-053** The `idempotencyKey` table stores key, user, request hash and the `{ id, version }` response for 24 hours, pruned nightly. [R4]
- **REQ-API-054** A retry with the same body replays the stored response; the same key with a different body answers `422`; no key answers `400`. [D29]
- **REQ-API-055** Idempotent methods (`PUT`, `DELETE`) and creates with a natural key (a legal text's next version) take no key; a repeat of the latter answers `409`. [D29]
- **REQ-API-056** Webhooks deduplicate on the provider's event id (`svix-id`, Stripe `event.id`) in the same table and acknowledge duplicates without applying them again. [D29]

## HTTP conventions

- **REQ-API-057** Every path starts with `/v1`, except `/health`. [D30]
  Why: embedded widgets on church websites can't be updated in lockstep with the APIs.
- **REQ-API-058** Public queries use the slug (`GET /v1/stories/{slug}`); commands and admin routes use the id; an old slug answers `301` to the current one through `slugHistory`. [D30]
- **REQ-API-059** Lists page by cursor only: `?limit=&cursor=` answers `{ data, nextCursor }`, with `nextCursor: null` on the last page, no total counts and no engagement metrics anywhere public. [D30]
- **REQ-API-060** Fields are camelCase, timestamps RFC 3339 UTC, and ids opaque record ids without the table prefix, which clients never parse. [D30]

## Errors and rate limits

- **REQ-API-061** Errors are RFC 9457 `application/problem+json` (`type`, `title`, `status`, `detail`, plus our `code` and `errors[]` with `pointer` and `message`), and never echo story text or other personal data. [D30]
- **REQ-API-062** Each status means what the table below says. [D30]

| Status | When                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | Malformed or invalid request; missing `Idempotency-Key`                                                                                    |
| 401    | Missing or invalid Clerk token                                                                                                             |
| 403    | Role or ownership check failed, or the person must agree first (`terms_agreement_required`, `testimony_consent_required`)                  |
| 404    | Not found, or not visible to the caller                                                                                                    |
| 409    | The resource's state doesn't allow it (not a draft, locked, in use; `agreement_version_changed`, `document_changed`)                       |
| 412    | `If-Match` doesn't match the current version                                                                                               |
| 422    | `Idempotency-Key` reused with a different body                                                                                             |
| 428    | `If-Match` missing                                                                                                                         |
| 5XX    | The service couldn't answer (e.g. the database is down): a bare `title` and `status`, never the cause (`ServerError`)                      |
| 503    | `service_restarting`: the database is restarting (Spot). `Retry-After` and `retryAfterSeconds` say when to try again (`ServiceRestarting`) |

- **REQ-API-063** The `503 service_restarting` answer is the one with its own code and `Retry-After`. [J-2026-11-07-API]
- **REQ-API-064** Contracts list every status an operation can answer, `5XX` included, and api-public-read's integration tests and web's e2e stub are checked against the contract (`@heisreal/contracts/testing`). [UNTRACED]
- **REQ-API-065** Rate limits use express-rate-limit, set up once in `libs/http` (`RateLimitModule`, the groups and numbers in `limits.ts`) and attached to each API's controllers in its app module. [RL-1]
- **REQ-API-066** A rate-limited caller gets exactly the generic `500` (`ServerError`): body `{"type":"about:blank","title":"Internal server error","status":500}`, `no-store`; no `429`, no `RateLimit-*`, `X-RateLimit-*` or `Retry-After` header, no code or wording of its own. [RL-5]
- **REQ-API-067** The rate-limited caller is its address: Express trusts exactly one proxy hop (Google's front end), and IPv6 counts by /56. [RL-8]
- **REQ-API-068** web's server sends api-public-read the website key in `X-Website-Key` (a private header); with the right key its calls share the `website` allowance, and a missing or wrong key is an ordinary caller. [RL-8]
- **REQ-API-069** api-admin's `RateLimits.refusals` counts a request with no sign-in as it arrives, and any other once it ends if answered `401`, or `403` to a caller who isn't staff (or hung up and isn't staff). [RL-2]
- **REQ-API-090** api-admin refuses an address over its refusals limit before anything else runs, and never counts signed-in staff. [RL-2]

## Caching

- **REQ-API-070** api-public-read answers a repeated public query from its own memory for up to 30 seconds (per running copy, at most 500 answers, no timers: `public-cache.ts`). [R13]
- **REQ-API-071** Public queries send `Cache-Control: no-store` until shared caching is turned on (`PUBLIC_RESPONSE_CACHING=on` on api-public-read), which is never in dev. [D51]
- **REQ-API-072** With shared caching on, a public answer sends `public, max-age=N`, N being the seconds left of its 30 (counted from when the database was asked; `no-store` when none is left), with no `stale-while-revalidate`, so it is never more than 30 seconds old in total, a `304` included. [R13]
- **REQ-API-073** While the database is restarting, api-public-read answers with the copy it kept (up to 30 minutes old) instead of `503 service_restarting`, sent `Cache-Control: no-store`. [J-2026-11-07-API]
- **REQ-API-074** web fetches story data `no-store`; personal and admin queries send `Cache-Control: private, no-store`. [D51]
- **REQ-API-075** Every query returns an `ETag`, accepts `If-None-Match`, and answers `304` with the same validator the `200` would carry (RFC 9110 §15.4.5). [D29]

## Agree first

- **REQ-API-076** The database, not the routes, enforces "agree first": routes carry no consent decorator or guard. [J-2026-11-01-DB]
- **REQ-API-077** A person agrees in their own session with `POST /v1/account/agreements/{agreement}` and `{ version }`, the version the page showed. [J-2026-11-01-DB]
- **REQ-API-078** The social media sharing consent travels with the submission: `POST /v1/stories/{id}/submit` with `{ socialMediaSharingConsent: { version } }`. [J-2026-11-01-DB]
- **REQ-API-079** The database refuses the person's own writes until they have agreed, with a message starting with a code the API turns into the problem in the table below. [J-2026-11-01-DB]

| The person's write                                                 | Needs                                         | Refused as                                                    |
| ------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------- |
| Create, edit or submit a story; request an upload URL (`api-user`) | The latest terms of use and testimony consent | `403 terms_agreement_required` / `testimony_consent_required` |
| Heart a story, `PUT /v1/account/favourites/{storyId}`              | The latest terms of use                       | `403 terms_agreement_required`                                |
| Withdraw a story, delete a story or a heart, delete the account    | Nothing                                       |                                                               |
| Agree, or tick sharing, on a version that is not the latest        | (refused)                                     | `409 agreement_version_changed`: the page shows what changed  |

- **REQ-API-080** Approving (`api-admin`) and publishing need the submitter's testimony consent, any version: an older one still covers the stories it was given for. [J-2026-11-01-DB]
- **REQ-API-081** Request bodies carry only the version a page showed, never a consent decision for someone else. [J-2026-11-01-DB]
- **REQ-API-082** The codes `agreement_not_own`, `agreement_time`, `agreement_kept` and `legal_version_kept` mean a programming error and answer `500`. [J-2026-11-01-DB]

## Writing to the database

- **REQ-API-083** A person's own commands run in a database session as that person, opened with their Clerk token (`PersonSessions.run(request, ({ session, user }) => …)` in `libs/auth`, on `withPersonSession`); admin commands run as `api-admin`'s login. [D27]
- **REQ-API-084** Work that waits on Bunny or reads everything a person has passes `'slow'` (`PERSON_WORK`), and its retries pass `PersonContext.deadline` to `runIdempotent` so they stop well inside that session (REQ-DBE-037). [DEC-T]
- **REQ-API-085** Who the caller is comes from a `PersonAuthenticator` (`ClerkAuthenticator` in `libs/auth`). [D27]
- **REQ-API-086** `runIdempotent` writes the key, the request hash and the stored `{ id, version }` in the same transaction as the command, in the command's session, so a retry after a lost response replays. [D29]
- **REQ-API-087** Of two requests racing with one key, exactly one applies; the other replays its response, or gets `422` if its body differs; there is no "in flight" state, so no `409` for it. [D29]
- **REQ-API-088** Every command handler checks it really wrote the rows it meant to (`requireWritten`), and otherwise fails loudly: it logs and never answers `2xx`. [D13]
  Why: a write the permissions deny returns an empty result, not an error.

## Spec extensions

- **REQ-API-089** The specs use these extensions: `x-required-role`, the minimum Clerk role (`User`, `Moderator`, `Admin`); `x-milestone`, the delivery milestone that builds the operation (`M0`–`M8`), lint-enforced. [D1]

`pnpm nx run contracts:lint-openapi` lints the specs (Redocly, recommended-strict) as part of `lint`.
