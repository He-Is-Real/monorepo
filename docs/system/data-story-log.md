# Data: the story status log and hiding for media

Covers: who may read and write `storyStatusLog` (`schema-04-stories.surql`) and how the database hides a story for its media; the story itself is in [data-stories.md](data-stories.md).
Data: `libs/database/schema/schema-04-stories.surql` is the source of truth.
Next id: REQ-DBL-048

## Contents

- Fields
- Reads
- Steps
- Updates and deletes
- Hiding for media

## Fields

- **REQ-DBL-001** `storyStatusLog` has one entry per step and is append-only. [R6]
- **REQ-DBL-002** `action` says what happened: `sent`, `editStarted`, `changesRequested`, `fileUnusable`, `approved`, `rejected`, `hiddenBySystem`, `shownBySystem`, `hiddenByModerator`, `shownByModerator`, `returnedToQueue`, and the history-only `fileReplaced`, `pictureReplaced` and `wordsChanged`. [J-2026-11-11-DB]
- **REQ-DBL-003** `status` is computed from the action (`editing`, `pending`, `approved`, `hidden`, `rejected`); a history-only entry keeps the story's. [J-2026-11-11-DB]
- **REQ-DBL-004** `actor` is set by the database: `person`, `moderator` or `system`. [R6]
- **REQ-DBL-005** `by` names the person or moderator; api-admin alone reads it. [R6]
- **REQ-DBL-006** Each entry also holds `story`, `storyVersion`, `comment` and `at` (server time). [R6]
- **REQ-DBL-007** `publishedAt` is on approved entries: the first approval's time, kept on later ones. [R6]
- **REQ-DBL-008** `hiddenReason` is `media_unavailable` or `media_changed`. [J-2026-10-23-DB]
- **REQ-DBL-009** `unusableFile` is on the system's `fileUnusable` entries only and required there: `recording` or `picture`, which file couldn't be used; the owner and api-admin read it. [P1-2]
- **REQ-DBL-010** `reviewedMediaFile` and `reviewedImageFile` are on approved entries: the files approved. [J-2026-10-23-DB]
- **REQ-DBL-011** `skippedMediaWait` marks an Admin's approval during the media wait; api-admin alone reads it. [DEC-5]
- **REQ-DBL-012** `senderIp` is the IP address a person's own `sent` entry was sent from, as api-user supplies it, lower-case; it is dropped on any other entry. [G21]
- **REQ-DBL-013** api-admin reads `senderIp` and shows it to Admins only; the owner reads it too, for their own "Download my data" export. [BL-4]
- **REQ-DBL-014** `senderEmail` is the email a person's own `sent` entry was sent with: the sign-in's verified email as api-user supplies it, lower-case, a valid email of at most 254 characters; it is dropped on any other entry. [EM-1]
- **REQ-DBL-015** `senderEmail` is `READONLY` and never cleared, so it goes only with the entry, that is with the story or the account. [EM-1]
- **REQ-DBL-016** api-admin reads `senderEmail` and shows it to Admins only; the owner reads it for their own export. [EM-1]
- **REQ-DBL-017** `staffEmail` is the Moderator's or Admin's verified email on a moderator's entry, as api-admin supplies it: required on every entry api-admin writes (`storyStatusLog_step`), dropped on any other entry, with the same email checks, `READONLY`. [EM-1]
- **REQ-DBL-018** api-admin alone reads `staffEmail`, like `by`. [EM-1]

## Reads

- **REQ-DBL-019** The owner reads their stories' entries, never `by` or `staffEmail` (and `senderIp` and `senderEmail` only on their own stories' entries); api-admin reads every entry. [R6]
- **REQ-DBL-020** Housekeeping reads every entry that isn't pending, for its `story`, `status` and `at` only, never who, what was said, the action, the files or `publishedAt`. [G3]
  Why: housekeeping finds the stories due for deletion, and a pending story never is.
- **REQ-DBL-021** Housekeeping reads a pending (`sent`) entry only while it still holds a `senderIp` 30 days old (`fn::story::sender_ips_expire_before`), never the address. [G21]
  Why: a field it may not read is NONE in its WHERE, so these rows are how it picks what to clear.
- **REQ-DBL-022** Housekeeping reads `hiddenReason`, set only on the system's own hides, to find the stories the site took off itself whose media check gave up; for housekeeping a story's current entry it can't read is pending (`fn::story::waiting`). [P1-8]
- **REQ-DBL-023** Everyone else reads only an entry's `story`, `status` and `publishedAt`, while it is its story's current approved entry. [R11]

## Steps

- **REQ-DBL-024** The owner, live, creates only `sent` and `editStarted` entries; api-admin creates only a moderator's actions. [R6]
- **REQ-DBL-025** System and history-only entries come only from the database's own events (elevated), never from a direct write. [R6]
- **REQ-DBL-026** `storyStatusLog_step` checks who may take which step (`fn::story::step_allowed`): the owner sends (from editing) and starts editing (Edit, from pending, approved or hidden). [J-2026-11-11-DB]
- **REQ-DBL-027** A moderator (api-admin, naming `by`) approves, sends back or rejects from pending, so of two decisions the first wins. [D-1]
- **REQ-DBL-028** From rejected, a moderator approves, sends back or puts the story back in the waiting list (`returnedToQueue` → pending, no note). [OV-1]
- **REQ-DBL-029** A moderator hides an approved story, with a note. [J-2026-11-11-DB]
- **REQ-DBL-030** From hidden, whoever hid it, a moderator shows the story again, sends it back or rejects it. [OV-2]
- **REQ-DBL-031** Each moderator step names the staff member's email (`staffEmail`). [EM-1]
- **REQ-DBL-032** No other step is allowed: a rejected story is never hidden, shown again or rejected again. [OV-2]
- **REQ-DBL-033** An approval from rejected runs every approval check (the media wait, the testimony consent) and keeps the story's first `publishedAt`. [OV-5]
- **REQ-DBL-034** The system hides and shows again for media, and `hiddenBySystem` needs a `hiddenReason`. [J-2026-10-23-DB]
- **REQ-DBL-035** The system sends a story back when its video or audio file can't be used (`fileUnusable`, from pending, approved or hidden), through `fn::story::check_files` in the same write as the file becomes `failed`. [J-2026-11-10-DB]
- **REQ-DBL-036** Sending back and rejecting need a note. [J-2026-11-11-DB]
- **REQ-DBL-037** History-only entries (`storyFile_attach`'s new file or picture, actor `system`; `story_words_changed`'s once-per-round changed words, actor `person`, while editing a story sent before) never move the pointer. [J-2026-11-11-DB]
- **REQ-DBL-038** Every other entry moves `story.currentStatus` in the same write, so the story's own events (shape, limits, agreements, approval gate) check the step too. [R6]
- **REQ-DBL-039** `fn::story::status_of($s)` (`currentStatus.status ?? 'editing'`) is the status every rule and event asks; app code uses `STORY_STATUS`, `IS_DRAFT` and `isPublished` from `libs/database` (`story-status.ts`), never the convention itself. [J-2026-11-06b-DB]

## Updates and deletes

- **REQ-DBL-040** No entry is deleted while its story exists. [R6]
- **REQ-DBL-041** The one update is housekeeping clearing `senderIp` 30 days after the entry (table `FOR update` for housekeeping on such entries only). [G21]
- **REQ-DBL-042** `storyStatusLog_append_only` refuses any update that changes anything else or doesn't clear `senderIp`, system users included. [R6]
- **REQ-DBL-043** The other fields are `READONLY`, and `senderIp`'s `VALUE` keeps a value only from a person's own `sent` entry or a system user, so housekeeping can only clear it. [G21]

Tests: `person-session`, `write-scope`, `public-view`, `block-list`, housekeeping's suite.

## Hiding for media

- **REQ-DBL-044** Whenever a story's file row or pointer changes, `fn::story::check_files` gives an approved story whose files have a problem a system `hidden` entry (`media_unavailable`), and one whose pointers aren't the reviewed files a system `hidden` entry (`media_changed`). [J-2026-10-23-DB]
- **REQ-DBL-045** A story the system hid comes back (a system `approved` entry, first `publishedAt` kept) only while it points at both reviewed files, they are ready, and the person still has testimony consent. [J-2026-10-23-DB]

Runbook: [media-runbook.md](../media-runbook.md). Tests: `media-processing`.
