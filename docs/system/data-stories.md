# Data: the story table

Covers: who may read and write `story` (`schema-04-stories.surql`); its status log is in [data-story-log.md](data-story-log.md), its files in [data-media.md](data-media.md).
Data: `libs/database/schema/schema-04-stories.surql` is the source of truth.
Next id: REQ-DBS-045

## Contents

- Content and reads
- Writes
- Shape and limits
- Approval
- Delete

## Content and reads

- **REQ-DBS-001** There is one `story` table, holding the story's content only. [R11]
- **REQ-DBS-002** `story.currentStatus` points at the story's newest status entry that moved it; none means a draft, never sent. [R6]
- **REQ-DBS-003** `image: {file}` and `mediaFile` point at the story's `storyFile` rows. [R12]
- **REQ-DBS-004** A picture has no description. [J-2026-11-14-DB]
- **REQ-DBS-005** The owner reads their story; api-admin, workflow and housekeeping read all rows. [R11]
- **REQ-DBS-006** api-admin's read covers the moderators' list with no database permission of its own; api-admin itself keeps drafts never sent (`currentStatus` NONE) to Admin sessions, on the list and on a story's review answer. [MD-3]
  Why: the database knows moderators only as api-admin's login.
- **REQ-DBS-007** Everyone else (the public, api-user's login, other people) reads only stories whose current entry is `approved`, and only the published fields. [R11]
- **REQ-DBS-008** Private fields (`submitter`, the sharing consent and its date, `createdAt`) are read only by the owner and the services that read all rows; api-user reads `submitter` only once the owner is erased, which erasure's delete needs. [R11]
- **REQ-DBS-009** Housekeeping never reads the words: `slug`, `title`, `description`, `body`, `bylineName`. [R11]
- **REQ-DBS-010** `themeIds` (text copies of `themeRefs`, computed) exists for the element index (REQ-DBE-018). [J-2026-11-06b-DB]
- **REQ-DBS-011** `slugHistory` keeps old slugs for a `301`; only system users write it. [D30]

## Writes

- **REQ-DBS-012** A person creates their own draft, live, after agreeing to the latest terms of use and testimony consent (`story_agreements`); `version` and `createdAt` are the server's. [J-2026-11-01-DB]
- **REQ-DBS-013** A write outside a login's write scope is dropped silently. [D41]
- **REQ-DBS-014** Content fields are written only by the person, and only while `editing` (`story_owner_content_lock`); never by api-admin or workflow. [D41]
- **REQ-DBS-015** File pointers change only through a new `storyFile` row (`storyFile_attach`, api-user's login), except that the person may take their picture off or change its description. [D41]
- **REQ-DBS-016** workflow may move `mediaFile` from an audio file to that file's own picture video: `mediaFile` permissions allow only a row whose `renderOf` is the current file, never off, and `story_files` refuses anything else as `media_not_granted`. [DEC-1B]
- **REQ-DBS-017** Moving `mediaFile` to the picture video keeps the story's `version` (`$renderMove`, set by the result writer only). [DEC-1B]
- **REQ-DBS-018** When a video or audio story enters `pending` from `editing`, the elevated event `story_media_jobs` writes a check job for its file (reason `submitted`). [J-2026-11-07-DB]
- **REQ-DBS-019** When an editable audio story's picture changes with the same file, `story_media_jobs` writes a `render` job (reason `picture_changed`). [J-2026-11-07-DB]
- **REQ-DBS-020** api-user sends the media jobs after the person's write. [J-2026-11-07-DB]
- **REQ-DBS-021** `currentStatus` changes only through the status log's event. [R6]
- **REQ-DBS-022** `submitter` is `READONLY` (a change is an error), and `updatedAt` is the server's time except for system users. [D41]

## Shape and limits

- **REQ-DBS-023** A `written` story needs non-blank text and no video or audio, and may have a picture (`fn::story::shape_problem`, event `story_shape`). [D53]
- **REQ-DBS-024** A `video` or `audio` story holds exactly one file of its format from submit on, and may also have a picture (an audio story's picture, a video's own thumbnail). [D53]
- **REQ-DBS-025** Pixel sizes are positive and never beyond 1:3 or 3:1 (`fn::shape::allowed`). [D53]
- **REQ-DBS-026** On the person's own writes only, no new draft is created over the open-drafts limit (`limit_open_drafts:`). [D112]
- **REQ-DBS-027** On the person's own writes only, no first submission happens before `fn::story::next_submission_at` (`limit_weekly_submission:`). [D113]
- **REQ-DBS-028** Whoever writes (system users and the migrator included), text over `storyTextMax` is refused only when it gets longer (`story_text_too_long:`). [J-2026-10-28-DB]
- **REQ-DBS-029** At submit, whoever writes, the text length and `themesMin`–`themesMax` themes, every one still existing, are checked (`story_text_too_short`, `story_theme_count:`, `story_themes_changed:`). [J-2026-10-28-DB]
- **REQ-DBS-030** There is no grandfathering: every later action meets the limits in force, and a story already submitted is never re-checked. [J-2026-10-30-DB]
- **REQ-DBS-031** The hard ceilings are 50,000 characters and 20 themes. [J-2026-10-28-DB]
- **REQ-DBS-032** Limits are anti-spam controls, not invariants: a write in flight when a setting changes may finish under the old values. [J-2026-10-28-DB]

Tests: `story-shape`, `submission-limits`, `themes`, api-user's `stories`.

## Approval

- **REQ-DBS-033** Approval is refused unless every file is `ready` with its sizes and length (`story_approval_media`, `fn::story::approval_problem`; `media_not_ready:`, api-admin `409`). [M1-A2]
- **REQ-DBS-034** Approval is refused unless the submitter has a testimony consent, any version (`story_approval_testimony`). [J-2026-11-01-DB]
- **REQ-DBS-035** A moderator's approved entry (from in review, or "show again" from hidden) is refused while an upload link for the story's video, audio file or picture could still be used (`media_recently_uploaded:`, with the time it can be approved). [DEC-5]
- **REQ-DBS-036** An upload link can be used until its row's `at` or `renewedAt` plus the link's length (`fn::upload::link_lifetime`: 1 hour, a picture 10 minutes) (`storyStatusLog_step`, `fn::story::approval_wait`). [DEC-5]
- **REQ-DBS-037** A moderator's approved entry is refused while a media job for the story's files is open (`media_still_processing:`). [J6]
- **REQ-DBS-038** An Admin may approve anyway while the media is still being processed: api-admin sets `skippedMediaWait` (roles live in Clerk), which the database accepts only on a moderator's approval that the wait would refuse. [DEC-5]
- **REQ-DBS-039** `skippedMediaWait` never skips the upload cooldown: `media_recently_uploaded:` stands. [G11]
- **REQ-DBS-040** The system's hide and show again, and system users, are never held by the media wait. [DEC-5]

Tests: `media-processing`, `agreements`, `approval-wait`.

## Delete

- **REQ-DBS-041** Erasure deletes stories (api-user, api-admin); api-admin's delete is also an Admin's Delete on the review page, with the role check in api-admin, as for every moderator action. [P1-11]
- **REQ-DBS-042** The owner, live, deletes their own story in any state. [ED-3]
- **REQ-DBS-043** Housekeeping deletes a story only for `fn::story::deletion_due(id)`, past `fn::story::deletes_at`, which the owner's page shows too (api-user's `deletesAt`). [G3]
- **REQ-DBS-044** A draft never sent is due 186 days (`fn::story::draft_retention`) after the later of `updatedAt` and its files' `renewedAt`. [D71]
- **REQ-DBS-045** A story in editing after it was sent is due the settings' `editingRetentionDays` after the later of `updatedAt` and its files' `renewedAt`. [G3]
- **REQ-DBS-046** A rejected story is due the settings' `rejectedRetentionDays` after its status entry's `at`, only while it is still rejected; an overturned story's clock stops, by its new state. [G3]
- **REQ-DBS-047** A story's delete takes its status log and others' hearts (`story_erasure_cascade`) and its search row (`story_search`), and queues its picture folder; its `storyFile` rows stay for the upload limits. [D39]

Tests: `person-session`, `write-scope`, `public-view`, api-user's `my-stories`, housekeeping's suite.
