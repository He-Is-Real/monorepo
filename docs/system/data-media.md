# Data: story files, media jobs, search and public lists

Covers: who may read and write `storyFile`, `mediaJob` and `storySearch` (`schema-04-stories.surql`), and how public lists read the database; the story itself is in [data-stories.md](data-stories.md).
Data: `libs/database/schema/schema-04-stories.surql` is the source of truth.
Next id: REQ-DBM-053

## Contents

- Story files: reads and creates
- Picture videos and Bunny's pictures
- Story files: updates and deletes
- Search rows
- Media jobs
- Public lists

## Story files: reads and creates

- **REQ-DBM-001** `storyFile` holds one row per uploaded file; its id is the Bunny video id or the picture's path (`stories/<story id>/<32 hex>.webp`, `fn::media::own_image`). [R12]
- **REQ-DBM-002** A picture id `dev-seed/<name>.webp` is allowed only for system users. [D49]
- **REQ-DBM-003** The person reads their own file rows; api-user, api-admin, workflow and housekeeping read all. [R12]
- **REQ-DBM-004** Everyone else reads only the id, `format`, `width`, `height`, `lengthSeconds` and `thumbnailPath`, of a file an approved story points at now. [R12]
- **REQ-DBM-005** api-user's login creates file rows; workflow creates only a picture video (`renderOf` set), which `storyFile_attach` doesn't handle and which doesn't count towards any upload limit. [DEC-1B]
- **REQ-DBM-006** Event `storyFile_render` lets workflow create a picture video only from an audio file of the same story and person, and only as `audio` itself. [DEC-1B]
- **REQ-DBM-007** For api-user's rows, `storyFile_attach` (elevated) checks the story is the person's, editable and at `storyVersion` (`story_cmd:stale_version`), and of that format (`upload_refused:`). [D80]
- **REQ-DBM-008** `storyFile_attach` checks the upload limits (`limit_upload_size|duration|hourly|weekly:`); a picture doesn't count towards the weekly limit. [D112]
- **REQ-DBM-009** For a picture, `storyFile_attach` checks that the story still shows `expectedImage` (`image_changed:`). [D80]
- **REQ-DBM-010** `storyFile_attach` then points the draft at the file; a new video also takes the story's picture off in the same write, so `story_files` detaches the old picture's row as for a removed one. [TC-9]
- **REQ-DBM-011** `story_files` refuses a pointer to a row of another story, another kind or a detached row (`media_not_granted`) for every login, system users included, and marks the replaced row `detachedAt`. [R12]
  Why: two stories sharing a row would have it hidden, detached and deleted through one while the other still shows it.
- **REQ-DBM-012** Dev-seed gives each story its own file rows; its stories that never go public use a placeholder row with a made-up Bunny-style id (`00000000-0000-0000-0000-…`) and nothing at Bunny. [D49]

## Picture videos and Bunny's pictures

- **REQ-DBM-013** `renderOf` (read-only) is the audio file a picture video was made from; only workflow writes it. [DEC-1B]
- **REQ-DBM-014** `thumbnailOf` is the picture Bunny shows for this video, or that this picture video was made with, and is only ever a picture of the same story (`storyFile_render`). [DEC-1B]
- **REQ-DBM-015** `renderOf` and `thumbnailOf` are private: they are not in the public read. [DEC-1B]
- **REQ-DBM-016** Only workflow writes a picture video's `thumbnailOf`. [DEC-1B]
- **REQ-DBM-017** When a story is sent, once Bunny shows the picture, api-user writes a video's `thumbnailOf`: only the current picture of the video a story being edited shows now, or NONE for none (`storyFile_update`, `picture_set:`). [P1-13]
- **REQ-DBM-018** `fn::story::approval_problem` refuses a story whose file's `thumbnailOf` isn't its picture now (`media_not_ready`). [P1-13]
- **REQ-DBM-019** When a story is sent, api-user writes a person's video's `thumbnailPath` in the write that records `thumbnailOf`: `<bunny video id>/<the file name Bunny's read-back named>`, or for a video never given a picture its untouched `thumbnail.jpg`. [RE-2]
- **REQ-DBM-020** api-user never writes a `thumbnailPath` our own confirmed set didn't produce. [RE-2]
- **REQ-DBM-021** `thumbnailPath` allows api-user only on a `video` with no `renderOf`, and `storyFile_update` only on the video a story being edited shows now and only a value `fn::media::own_thumbnail` accepts (`picture_set:`). [RE-2]
- **REQ-DBM-022** workflow writes `thumbnailPath` only on audio rows (an audio story's picture video), never on a person's video. [RE-2]
- **REQ-DBM-023** api-admin's approval compares `thumbnailPath` with Bunny's current file name, with no database write. [RE-2]

## Story files: updates and deletes

- **REQ-DBM-024** workflow updates the processing fields: `width`, `height`, `lengthSeconds`, `thumbnailPath` of audio rows only, and `processing`. [D41]
- **REQ-DBM-025** workflow writes `checkedAt`, when the newest answer applied reached the result writer, read like `processing`; the result writer applies only later answers, in the same transaction. [F1]
- **REQ-DBM-026** api-user writes `renewedAt` (server time) through `fn::upload::renew`, which refuses unless the story still exists, is the person's, is editable and shows that file (`nothing_to_resume:`). [D71]
- **REQ-DBM-027** api-user writes a picture's `processing` only as the picture check at submit: only to `ready`, only on a picture not marked yet, and only the one a draft (or story sent back for changes) shows now (`storyFile_update`, `picture_check:`). [R3]
- **REQ-DBM-028** Events write `detachedAt`. [R12]
- **REQ-DBM-029** Housekeeping writes `removedAt` once, not before `fn::upload::links_expire_after()`, 2 h (`file_not_removable`). [R12]
- **REQ-DBM-030** Housekeeping deletes the file at Bunny or in the images zone first; a 404 counts as done, so a placeholder's made-up id is fine. [R12]
- **REQ-DBM-031** A picture outside the stories' folders (dev-seed's fixed pictures, which every reset reuses) is marked removed but never deleted. [D49]
- **REQ-DBM-032** When a file the story points at changes in a field its owner's story shows (`fn::story::file_view`: `format`, `thumbnailPath`, `width`, `height`, `lengthSeconds`, `processing`), `storyFile_update` steps the story's `version` once in the same write, not again if that write hid it or showed it again. [D29]
  Why: so the owner's `ETag` and `If-Match` see processing.
- **REQ-DBM-033** api-user's picture check doesn't step the story's `version`: the owner's story never shows a picture's `processing`, and the submit that follows stays at the person's `If-Match`. [D29]
- **REQ-DBM-034** api-user deletes file rows (erasure); housekeeping deletes a row older than 7 days whose file is removed or whose story is gone. [R12]
- **REQ-DBM-035** Upload limits are counted from file rows, so replacing a file or deleting a story frees no upload limit. [D113]

Tests: `uploads`, `images`, api-user's `uploads`, housekeeping's suite.

## Search rows

- **REQ-DBM-036** `storySearch` holds one row per published story: `story`, `searchText` (title, description, written text and its themes' current names) and what public lists filter and sort on (`primaryFormat`, `themeIds`, `publishedAt` of the current approved entry), with full-text index `storySearch_fts`. [J-2026-11-06-DB]
  Why: BM25 counts every indexed row, so drafts in the index moved published stories' scores.
- **REQ-DBM-037** Search filters, scores, sorts and pages inside `storySearch`, then builds cards for one page. [J-2026-11-06-DB]
- **REQ-DBM-038** Everyone reads a search row only while its story's current entry is `approved`; only events write it (`story_search`, `storySearch_theme_renamed`, via `fn::story::sync_search`). [J-2026-11-06-DB]
- **REQ-DBM-039** Writing a search row's words bumps `fence:theme-<id>` for each of its themes, as a theme rename or delete does, so a row built from a snapshot can't commit alongside a rename or delete of one of its themes. [R5]

Tests: `story-search`.

## Media jobs

- **REQ-DBM-040** Every media job is a `mediaJob` row written before it is queued: `file`, `kind` (`check`, `render`), `reasons` (`bunny_finished`, `bunny_failed`, `bunny_deleted`, `submitted`, `picture_changed`, `resent`, `rendered`), `queuedAt`, `sentAt`, `sends`, `failures`, `lastError` (a short code), `madeFile`, `doneAt` and `outcome`. [J-2026-11-07-DB]
- **REQ-DBM-041** `madeFile` is a render job's new Bunny video, made before its row; housekeeping never deletes it while the job is open. `doneAt` and `outcome` (`applied`, `stale`, `gone`, `gave_up`) are set once, together. [J-2026-11-07-DB]
- **REQ-DBM-042** `errorType` says why a job gave up (`file_unusable`, `bunny_unavailable`, `worker_error`, `other`): set with `gave_up` and only then, once; only workflow writes it and only api-admin reads it. [P1a-4]
- **REQ-DBM-043** No person's session or the public reads a job; api-admin reads them for the moderators' list's "a problem on our side" (`fn::media::our_problem`). [J-2026-11-07-DB]
- **REQ-DBM-044** api-user and workflow create jobs, and housekeeping only a `check` with the reason `resent` (the nightly retry of a waiting story's file after our own give-up), through `fn::media::queue_job`, which adds a reason to the file's open job of that kind instead; the `mediaJob_rules` event refuses a second open one. [J-2026-11-07-DB]
- **REQ-DBM-045** The `mediaJob_rules` event (elevated) takes a new job away at once when its file's story is waiting for review or off the site because the site took it off, and the file has used its 3 nightly retries (`fn::media::retries_used`); `queue_job` then answers NONE, whoever called it. [P1-9]
  Why: elevated, since workflow and api-user can't read a waiting story's status.
- **REQ-DBM-046** api-user updates new reasons, `sentAt` and `sends`; housekeeping the 18:00 resend (`sentAt`, `sends`, the reason `resent`); workflow all of it; only workflow writes `failures`, `lastError`, `madeFile`, `doneAt`, `outcome` and `errorType`. [J-2026-11-07-DB]
- **REQ-DBM-047** Housekeeping deletes a job 30 days after it ended, but never while its file's story is waiting for review or off the site because the site took it off itself (`fn::media::job_kept`), so its give-ups keep counting and its 3 nightly retries never start again. [P1-9]
- **REQ-DBM-048** A file's row going deletes its jobs (`storyFile_jobs`). [J-2026-11-07-DB]
- **REQ-DBM-049** Every job write needs the file's person live and bumps their fence, which also serialises two writes racing to open the same job; the result writer saves an answer and ends its job in one transaction. [J-2026-11-07-DB]

An open job holds a moderator's approval of its story: REQ-DBS-037. Tests: `media-jobs` (here,
workflow's and housekeeping's), `person-linked`, api-user's `media-webhook`, `approval-wait`.

## Public lists

- **REQ-DBM-050** Browse newest, oldest, by theme or format reads the status log's `(status, publishedAt)` index: the current approved entries (`PUBLISHED_ENTRY`) in publish order, filtered by format and theme until a page is full, then that page's cards. [UNTRACED]
  Why: 3.2.4 stops the index scan at the `LIMIT`, so a page reads only what it needs.
- **REQ-DBM-051** A public list's cursor is a range on `publishedAt`, and the page's last instant is read whole, so ties sort by story id across pages. [UNTRACED]
- **REQ-DBM-052** Related stories count shared themes in one `story_theme_ids` scan (`themeIds CONTAINSANY`), and the newest of the level that fills the sidebar come from the status log index. [UNTRACED]

Local timing: `pnpm nx run api-public-read:scale-test`.
