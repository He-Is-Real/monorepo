# M1 step 6a: the browse read API — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** api-public-read serves what the M1 pages need (browse, search, tags, related), and web
gets typed calls for them. The pages themselves are step 6b.

**Architecture:** New query handlers in `apps/api-public-read/src/app/stories/`, reading only
`publicStory` and `tag` on the read-only login. Keyset pagination with an opaque, filter-bound
cursor. One shared function builds media and image URLs (null until step 5 signs them). The read
model gains a computed `durationSeconds`, because cards show the length of a clip.

**Tech Stack:** NestJS 11 on Express 5, surrealdb.js 2, SurrealDB 3.2.4 (BM25 full-text index
`publicStory_fts`), Next.js (web `lib` only), Jest, OpenAPI 3.1 (Redocly).

**Spec:** the task brief (M1 step 6a), `project/context/future/content/{home,browse,story-pages}.md`,
the mockups in `project/context/future/design/public/`, D53 and D55, `docs/api-conventions.md`.

## Global Constraints

- api-public-read stays anonymous, read-only and published-only: it reads `publicStory` and `tag`
  only. Never widen its login.
- Every value reaches SurrealQL as a bound parameter. Query text is fixed.
- Every input is validated and bounded; bad input is `400` problem+json with `errors[]`
  (`pointer`, `message`) and never echoes the input.
- `Cache-Control: public, max-age=60, stale-while-revalidate=300` on every `200`, `301` and
  `304`; weak `ETag` (`W/"…"`) on collections; `If-None-Match` → `304` with the same ETag.
- Cursor pagination `{ data, nextCursor }`; no total counts; no engagement metrics.
- No playback URLs in cards. Thumbnail and image URLs come from one shared function.
- D55: cards carry the facts for predicted heights: media or image width and height, and a
  bounded text excerpt.

## Design decisions (my calls)

- `GET /v1/stories`: `q` (1–200 chars after trim, blank = absent), `tag` (repeatable, at most 5,
  slug pattern; a story must have all of them), `format` (`video|audio|written`), `sort`
  (`latest|oldest|relevance`; default `relevance` with `q`, else `latest`; `relevance` without
  `q` is `400`), `limit` (1–50, default 20), `cursor` (at most 300 chars). Unknown or repeated
  parameters are `400`: fewer cache keys and no silent typos.
- Cursor: base64url JSON `{ v: 1, f: <hash of the filters and sort>, k: [<sort key>, <id>] }`.
  A cursor used with other filters is `400 invalid_cursor`. Keys: `publishedAt` as SurrealDB's
  own string (full nanosecond precision) for latest/oldest; the BM25 score for relevance. The id
  breaks ties, so the order is total and stable.
- `StorySummary`: `id, slug, title, excerpt, bylineName, primaryFormat, durationSeconds,
thumbnailUrl, thumbnailWidth, thumbnailHeight, image, textLength, tags, publishedAt`.
  `excerpt` = the description, else the body, cut at a word to at most 240 characters with `…`.
  `textLength` = the body's characters (0 if none), for "n min read". `description` leaves the
  card (it can be 5,000 characters).
- `GET /v1/stories/{slug}/related`: fixed 3 cards (the mockup's sidebar), most shared tags first,
  then newest; never the story itself; filled with the newest when few share tags. An old slug
  answers `301` to the current one's `/related`. The `limit` parameter leaves the contract.
- `GET /v1/tags`: all tags, sorted by category (theme, journey, emotion) then name. No counts
  (`docs/api-conventions.md`: no totals). Grouping is the client's (each tag has `category`).
- No featured endpoint: the featured list is M5 (`/admin/stories/featured`). Home can use the
  newest stories or `FEATURED_STORY_SLUG` until then.
- web `lib`: `browseStories`, `getRelatedStories`, `listTags`. They revalidate every 60 s
  (ISR); search results (`q`) are fetched `no-store` so arbitrary text doesn't fill the cache.

## Review Focus

- Non-Latin search (Greek, Arabic, Korean): matches the seeded `test-video-non-latin` → Task 3.
- A query that analyses to no terms (`q=!!!`) → `200` with no stories, not `500` → Task 3.
- Two stories with the same `publishedAt` across a page boundary: neither lost nor repeated → Task 2.
- A tampered or foreign cursor (bad base64, wrong filters, huge) → `400 invalid_cursor` → Task 2.
- Unapproved stories (pending, in review, rejected, withdrawn, draft) never appear in any list,
  search or related result → Tasks 2–4.

---

### Task 1: The read model carries media duration

Changed while building: a computed field instead of a mirrored one. Mirroring would have changed
every publisher's `CREATE` (the test world, dev-seed, and the unpublish branch's republish event).

**Files:**

- Modify: `libs/database/schema/schema.surql` (`publicStory.durationSeconds` with
  `VALUE type::record('story', record::id(id)).media[0].durationSeconds`)
- Test: `libs/database/integration/write-scope.int-spec.ts`

- [x] Failing test: after approval the row has the story's duration, and a writer can't change it.
- [x] Add the field. Tests pass.
- [x] `getStoryBySlug` returns `media[].durationSeconds`.

### Task 2: List published stories (latest/oldest, tags, format, cursor)

**Files:**

- Create: `apps/api-public-read/src/app/stories/browse.query.ts` (validation → `BrowseQuery`; cursor encode/decode)
- Create: `apps/api-public-read/src/app/stories/story-summary.ts` (`StorySummary`, `toSummary(row)`, `excerpt()`, `SUMMARY_FIELDS`)
- Create: `apps/api-public-read/src/app/stories/media-urls.ts` (`mediaThumbnailUrl`, `imageUrl`: null until D52)
- Create: `apps/api-public-read/src/app/stories/collection.ts` (`sendCollection(res, ifNoneMatch, body)`: weak ETag, cache, 304)
- Modify: `stories.controller.ts` (route `GET /v1/stories` before `:slug`)
- Modify: `libs/http/src/lib/problem.filter.ts` (`ProblemException` takes optional `errors[]`)
- Create: `apps/dev-seed/integration/dev-database.ts` + `package.json` export `./testing` (the loader, reused)
- Test: unit specs per file; `apps/api-public-read/integration/browse.int-spec.ts`

- [ ] Unit tests: validation (every bound, unknown/repeated params, blank q), cursor round trip and rejection, excerpt cutting (word, no-space scripts, surrogate pairs).
- [ ] Integration (dev dataset): all approved stories exactly once over pages of 1, 5, 50; order newest first and oldest first; tag AND filter; format filter; equal `publishedAt` tie; none unapproved; `304`; `400` problems.
- [ ] Implement; tests pass; commit.

### Task 3: Search (BM25)

- [ ] Integration: English stems, non-Latin words, `relevance` order and paging, no-term query, `q` with `sort=latest`.
- [ ] Implement `searchText @1@ $q` with `search::score(1)` keyset; commit.

### Task 4: Related stories and tags

- [ ] Integration: 3 cards, most shared tags first, never itself, never unapproved, old slug `301`, unknown `404`; tags sorted, no counts, `304`.
- [ ] Implement `RelatedController` route and `TagsController`; commit.

### Task 5: Contract, web client, docs

- [ ] `api-public-read.yaml` + `components.yaml` (`StorySummary`, parameters, `invalid_cursor`); `pnpm nx run contracts:lint-openapi`.
- [ ] `apps/web/src/lib/public-stories.ts`: `browseStories`, `getRelatedStories`, `listTags` with unit tests.
- [ ] `docs/delivery-status.md`, README (the integration line), `apps/dev-seed/README.md` if the loader moves.
- [ ] `pnpm nx run-many -t lint test build typecheck`; integration targets; commit; PR.
