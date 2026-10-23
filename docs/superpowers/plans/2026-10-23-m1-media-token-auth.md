# M1 step 5: media token auth (D52) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bunny refuses unsigned media links. api-public-read hands out signed, expiring links
for published stories only, and web plays and shows them.

**Architecture:** OpenTofu turns on Bunny's token auth (Stream embed + Stream CDN + the images
pull zone) and copies the two signing keys into Secret Manager (bunny root, write-only), with
accessor grants for api-public-read only. api-public-read reads the keys at startup through
`libs/secrets` and signs URLs in a `MediaUrls` provider. web renders the signed player iframe
and image. The gcp root passes the identifiers (library id, CDN hostnames, secret names) behind
a flag that stays off until the bunny root has applied.

**Tech Stack:** OpenTofu 1.13 (bunnynet 0.19, google 8.x), NestJS 11, Next.js, Playwright, Jest.

**Spec:** D51, D52 (`docs/delivery-status.md`; `project/context/research/m1-dev-data-decisions.html`),
Bunny's docs: embed token = `sha256_hex(key + videoId + expires)`; CDN advanced token =
`"HS256-" + base64url(HMAC-SHA256(key, path + expires))` (Basic MD5 is deprecated); the Stream
embed and CDN tokens share one key: the Stream pull zone's token auth key.

## Global Constraints

- Keys only via Secret Manager (`libs/secrets`); never in env literals, logs, outputs, the repo, or
  any state but the bunny root's (D57). Secrets named `bunny-*` (only tf-bunny manages them).
- api-public-read signs only what `publicStory` holds (published stories).
- No paid Bunny features. No autoplay (design principle).
- CI logs are public; bunny is planned/applied only through `tf.sh` and `plan-summary`.
- No `tf.sh apply`, no Bunny changes by hand.

## Design decisions (my calls)

- **Expiry: at least 6 h, bucketed to the hour** (`expires = ceil((now + 6 h) / 1 h) * 1 h`), so
  a link has 6–7 h left when issued. D52: links outlive any cached response (60 s + 300 s
  swr today). The bucket keeps the body, and so its ETag, stable for an hour, so `304`s still
  work. web fetches stories `no-store` and renders per request (no ISR), so a page never holds
  an older link than the API gave it.
- Thumbnails are Stream CDN files (`<videoId>/thumbnail.jpg` on `vz-…b-cdn.net`): signed with the
  Stream key. Images: the `images` pull zone, its own key.
- Paths are signed only if they match `^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$` without `..`
  segments (no encoding ambiguity); video ids only if UUID-shaped. Anything else gets `null`.
- Signing is all-or-nothing: no `BUNNY_*` env → URLs `null` (today's behaviour, logged once);
  some but not all → startup fails; all set → keys read at startup; unreadable → startup fails.
- **Rollout flag:** `api_public_read_media` (gcp module, `null` = off). Set in a follow-up PR
  once the bunny apply has created the secrets and grants, so a gcp apply can never start a
  revision that can't read its keys (wave 1 applies gcp and bunny in parallel).
- web: the iframe's `allow` omits `autoplay` (the browser then refuses autoplay); the player
  also gets `autoplay=false&preload=false`. Audio uses the same embed, at a short fixed height.

## Review Focus

- A path with `..`, `%`, spaces or a leading `/` → `null`, never a signed URL for another file → Task 1.
- Expiry exactly on an hour boundary → still ≥ 6 h left → Task 1.
- A key with trailing newline in Secret Manager → trimmed, same token as without → Task 2.
- Partial configuration (library id but no key secret) → startup error naming the missing variable → Task 2.
- A `null`/missing `bunnyVideoId` or `thumbnailPath` in the read model → `null` URLs, no throw → Task 3.

---

### Task 1: Signing functions

**Files:** Create `apps/api-public-read/src/app/media/bunny-tokens.ts` + `.spec.ts`.

**Interfaces — Produces:**

- `LINK_TTL_SECONDS = 21600`, `LINK_BUCKET_SECONDS = 3600`
- `linkExpiry(nowMs: number): number` (Unix seconds)
- `signEmbedUrl(libraryId: string, videoId: string, key: string, expires: number): string | null`
- `signCdnUrl(host: string, path: string, key: string, expires: number): string | null`

- [ ] Tests: known answers from Bunny's reference implementation (`SecurityKey`, `1598024587`:
      `/300kb.jpg` → `HS256-o10JRWlsAItyAsdKS6jJKjabHN4FrFsplDHPV1idcX4`); embed token =
      sha256 hex of `key+videoId+expires`; unsafe paths and ids → `null`; expiry boundaries.
- [ ] Implement; tests pass; commit.

### Task 2: `MediaUrls` provider and config

**Files:** Create `apps/api-public-read/src/app/media/media-urls.ts` + `.spec.ts`; modify
`app.module.ts`, `.env.example`.

**Interfaces — Produces:** `MEDIA_URLS` token; `class MediaUrls { playbackUrl(videoId?): string | null;
thumbnailUrl(path?): string | null; imageUrl(path?): string | null }`; `MediaUrlsModule` (global);
`mediaConfigFromEnv(env): MediaConfig | null`. Env: `BUNNY_STREAM_LIBRARY_ID`,
`BUNNY_STREAM_CDN_HOST`, `BUNNY_IMAGES_CDN_HOST`, `BUNNY_STREAM_TOKEN_KEY_SECRET`,
`BUNNY_IMAGES_TOKEN_KEY_SECRET`.

- [ ] Tests: none set → `null` config and null URLs; partial → error naming the missing ones;
      bad host/id formats refused; keys trimmed; an injected clock.
- [ ] Implement; commit.

### Task 3: Story endpoint signs media

**Files:** modify `stories/stories.controller.ts` (+ spec), `integration/stories.int-spec.ts`.

- [ ] Tests: published video → signed `playbackUrl` and `thumbnailUrl`; written with image →
      signed `image.url`; signing off → nulls; ETag stable within the hour.
- [ ] Implement; commit.

### Task 4: Contracts

- [ ] `components.yaml` `MediaPlayback`/`StoryImage` descriptions (signed, expiry, `null` cases);
      `pnpm nx run contracts:lint-openapi`; commit.

### Task 5: web plays and shows media

**Files:** create `apps/web/src/components/stories/story-media.tsx` (+ spec); modify `story-view.tsx`,
`e2e/stub-api.mjs`, `e2e/responsive.e2e.ts`.

- [ ] Unit: iframe with `autoplay=false&preload=false`, no `autoplay` in `allow`, title; image with
      alt default; nothing when URLs are null.
- [ ] e2e: a video story and an image story fit every device without sideways scroll.
- [ ] Commit.

### Task 6: OpenTofu

**Files:** `modules/bunny/{main,secrets,variables,outputs}.tf`, `modules/bunny/tests/*.tftest.hcl`,
`live/dev/bunny/main.tf`, `modules/gcp/{cloudrun,variables}.tf`, `live/dev/gcp/main.tf`,
`.github/workflows/tofu-plan.yml` (test the bunny module).

- [ ] tftest (mock providers): token auth flags on; secrets `bunny-stream-token-key`,
      `bunny-images-token-key`; accessor only for the given member, only on those two.
- [ ] gcp: `api_public_read_media` object (validated), env added only when set.
- [ ] `tf.sh bunny plan` → `plan-summary` only; `tf.sh gcp plan` clean; commit.

### Task 7: Behavioural tests and docs

- [ ] `apps/dev-seed/behavioural/media.behaviour.ts`: published media URLs are signed and load
      (200); the same URLs unsigned, expired or tampered → 403; an unpublished image path unsigned → 403.
- [ ] Docs: delivery-status (step 5, D52 implemented, changelog), infra README (apply order),
      api-public-read env, dev-seed README; commit; PR.
