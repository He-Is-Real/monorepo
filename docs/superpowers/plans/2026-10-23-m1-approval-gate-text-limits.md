# M1 step 3b: approval waits for media processing (A2), story text limits (A3)

Source: Joel's decisions of 2026-10-23 (recorded in `docs/delivery-status.md`), follow-ups to #57
(D53, D48). Out of scope: the M7 processing itself, api-admin's ApproveStory and api-user's
SubmitStory commands (M3, M2; this PR gives them the database rules, the error matchers and the
contract), the dev seed (step 4).

## Findings that shape the design (SurrealDB 3.2.4, probed before planning)

- **A denied nested field keeps its old value.** With `PERMISSIONS` on `media[*].processing` alone,
  a person who replaced a processed video with a new one would keep `ready`. So the field VALUE of
  `media` and of `image` decides `processing` on every write instead.
- **A field VALUE runs for a nested `SET` too** (`SET media[0].x = ...`), with `$value` the whole
  new field and `$before` the old one. `object::remove` and `array::find` work in closures there.
- **Who is `$auth` in a VALUE:** the `service` record for a service session, NONE for system users.

## A2 tasks

1. **Integration tests first** (`libs/database/integration/media-processing.int-spec.ts`):
   - the person can't set `processing` (create, `media[0].processing`, a whole new `media`, the
     image); api-admin's writes are dropped; workflow can (media and image), but can't change the
     image's other fields or remove it; unknown states are refused;
   - any change by the person (another upload, another size, another image, path or alt text)
     sets it back to NONE; unchanged items and re-sent media keep it;
   - approval is refused for each missing fact (unprocessed, processing, failed, no size, no
     duration, zero duration, audio without duration, image not ready or failed), also for the
     migrator, and goes ahead once processed; a video replaced after processing needs processing
     again;
   - `publicStory` refuses a re-sync or a new row once an approved item is no longer `ready`.
2. **Schema:** `media[*].processing` and `image.processing` (option, `processing`/`ready`/
   `failed`), the VALUE rules on `media` and `image` (`image` now allows workflow writes; its
   sub-fields don't), `processing` in `$mediaFields`, `fn::story::approval_problem`, event
   `story_approval_media`, the check in `publicStory_mirrors_story`. Messages start with
   `media_not_ready:`.
3. **Harness:** `processed()` (workflow records processing), `approve()` copies only the image's
   public fields; suites that approve media call `processed()` first.
4. **`libs/database`:** `isMediaNotReadyError`, unit-tested, for ApproveStory's `409`.
5. **Contracts:** ApproveStory documents `409 code: media_not_ready`; `MediaPlayback.processing`
   and `StoryImage.processing` for the person's and moderators' views; a published video always
   has its size (no square fallback needed for it).
6. **Data:** no script. The events fire on new approvals and read-model writes only, and dev's only
   story (0003) is written, with no media or image.

## A3 tasks

1. **Schema:** `story.body` at most 10,000 characters; a written story needs 200 trimmed characters
   from submit on (`fn::story::shape_problem`), measured by `fn::text::trimmed_length` (JavaScript's
   trim plus `string::trim`; 3.2.4's `string::trim` keeps U+FEFF). Tests: 10,000 vs 10,001, a short draft saved,
   199 vs 200 trimmed on submit, no minimum for video/audio, the migrator held to it too.
2. **Harness:** drafts get text long enough to submit (`STORY_TEXT_PADDING`, `storyText()`).
3. **`libs/database`:** `STORY_TEXT` limits and `isStoryTextTooShortError` for SubmitStory's `400`.
4. **Contracts:** `maxLength: 10000` on `CreateDraftStory.body` and `StoryPatch.body`; submit
   documents `400 code: story_text_too_short`.
5. **Web:** `previewCut` (about 600 characters, at a word, no button for under 100 hidden
   characters) and `StoryText` (a real button with `aria-expanded`/`aria-controls`, 44 px, focus
   kept, scrolled into view on collapse, collapsed on the server so nothing moves on hydration,
   the full text in the HTML, a noscript style that shows it all). Unit tests and a Playwright
   test on every device and both schemes.
6. **Data:** none: 0003's text has 222 characters.

## Verification

`pnpm nx run-many -t lint test build typecheck`, `pnpm nx run database:test-integration`,
`consent:test-integration`, `api-public-read:test-integration`, `pnpm nx run web:e2e`,
`pnpm nx run contracts:lint-openapi`.
