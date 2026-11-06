# Database permissions

Who may read and write what in SurrealDB, the engine quirks that shape the schema, and what
command handlers must do about them. The schema (`libs/database/schema`) is the source of truth
and its comments give the field-level detail; this page is the map. The reasoning behind the rules
is in the decision docs in `../project/context/research` (`m0-schema-consent-decisions.html`,
`privacy-consent-architecture.html` section 4e, `db-review-2-decisions.html`); git history has the
review rounds that led here.

Runs on **SurrealDB v3.2.4** (the digest the cluster runs) with **surrealdb.js 2.0.8**.

## Files and tests

| Path                                      | What                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `libs/database/schema/schema-0N-*.surql`  | Declarative schema (D14), one file per area, applied in name order as one step |
| `libs/database/schema/access-clerk.surql` | `DEFINE ACCESS clerk`, only when `$clerk_jwt_public_key` is set                |
| `libs/database/schema/data/000N-*.surql`  | Run-once data scripts (0006 settings, 0009 legal texts v0, 0010 theme Other)   |
| `libs/database/schema/migrate.py`         | The D14 runner: the migrate Job and the tests both use it                      |
| `libs/database/integration/*.int-spec.ts` | Integration tests against a real SurrealDB                                     |

```bash
pnpm nx run database:test-integration    # needs Docker
```

- The schema sits under an Nx project so a schema change makes it "affected" and runs
  `test-integration` in CI.
- Vitest's global setup runs `docker run` with the image from
  `infra/k8s/surrealdb/base/kustomization.yaml` (tag + digest), on RocksDB, the production engine.
  `SURREAL_TEST_URL` / `SURREAL_TEST_USER` / `SURREAL_TEST_PASS` use a running server instead.
- Each spec file gets its own namespace. An OWNER `migrator` applies the bundle with `migrate.py`;
  each service gets a `service` record with a random argon2-hashed password; Clerk is an RS256 key
  pair generated per run, passed as `clerk_jwt_public_key`.
- Every **denied write** test asserts the empty result **and** checks, through the migrator, that
  the row is unchanged or absent.

## Who connects

- **System users** (`$auth = NONE` in rules): the `migrator` (OWNER, schema and data scripts), the
  backup (VIEWER), and in dev only `dev_seed` (EDITOR, created only when OpenTofu sets
  `dev_seed_login`; its reset refuses unless `_setting:current` says dev). They bypass
  permissions, but every event still runs. Many fields let a system user supply a value (times,
  `actor`, `updatedAt`) so data loads and tests can age rows.
- **Services** sign in with record access `svc` as a `service` record: `service:api_public_read`
  (read-only), `api_user`, `api_admin`, `workflow`, `housekeeping`. Passwords come from Secret
  Manager; SurrealDB's startup init writes the hashes (`infra/k8s/surrealdb/base/init.surql.tmpl`).
- **People** open a session with their Clerk token (`DEFINE ACCESS clerk`, `sub` → `user` by
  `clerkUserId`; see "Clerk side"). A person's commands run in their own session (D27), so the
  database checks ownership. Moderators and admins act through api-admin's login, which names them
  (`by`, `changedBy`, `publishedBy`).
- Only the migrator can `DEFINE`/`REMOVE` anything; every service and person session is refused,
  and the guard events and functions survive the attempts (`schema`).

## Rules by table

"Live" below means `fn::person::live`: the person exists and isn't erased, and the write bumps
their fence (see "Transactions").

### People (`schema-02-people.surql`)

- **`user`.** A person reads their own row; api-user, api-admin and workflow read all. Only
  api-user's login creates one (on first use, `provisionPerson`). Updates: api-user and api-admin
  (erasure; api-admin's legacy link), and the person's own session for their agreement pointers
  only (`user_agreements`). Nobody deletes. `clerkUserId` changes only `NONE` → id for a live user
  (not by api-user) or id → `NONE` by erasure (`user_clerk_binding`, `user_erasure_final`, on create
  too). `status` is `active` or `deleted`: erasure sets it, and it never goes back. Every "is this
  person erased?" rule asks `status = 'deleted'`. Specs: `person-session`, `erasure`,
  `service-permissions`.
- **`favourite`** (hearts, private): id `favourite:<ulid>`, made within 5 s of now
  (`fn::favourite::made_now`, so none is backdated); one per person and story. Only the person
  reads, creates and deletes their own; nobody updates; no service login reads them, nor does the
  story's owner. A new heart needs a live person, fences the story's owner too, needs the latest
  terms of use and a story published now (`favourite_rules`). A story that stops being public
  keeps its hearts; lists read only public stories, so it drops out. Erasure deletes the person's
  hearts (`user_erasure_favourites`) and a story's delete takes its hearts. Not built: the owner's
  count per story. A person can't count others' rows, so it will be a counter the
  `favourite_rules` event keeps in its own table (never on the story, so hearts don't bump its
  `version`), readable by the owner only: a number, never who. Specs: `favourites`, api-user's
  `favourites`.
- **`erasedIdentity`** (D82 tombstone): id = sha256 of the Clerk user id, nothing else. Only
  api-user's login reads or creates it; nobody updates or deletes it. `user_not_erased_identity`
  refuses that Clerk id on any `user` create or update. It is a retained identity fingerprint
  (pseudonymous personal data, not anonymous), kept so a deleted sign-in can't come back; the
  privacy policy must say so.
- **`pendingDeletion`** (D40): what must still go outside the database: `bunny_video`, `image` (a
  deleted story's folder `stories/<story id>/`) and `clerk_user`. No person link. api-user creates
  rows (never `image`); a story's delete queues its folder (`story_picture_folder`, keyed
  `pendingDeletion:⟨image-<story id>⟩`, from the story row, whoever deletes it). api-user and
  housekeeping read, update `attempts`/`nextAttemptAt` (`fn::erasure::retry_after`: 1 h, doubling,
  at most a week) and delete rows. A folder row can't be deleted before its `finalPassAt` (15 min
  after the delete, `fn::erasure::final_pass_after`), because a picture PUT link signed just
  before the delete lives 10 minutes. A story can't be created while its folder row is still
  queued (except by a system user), so an old row never deletes a new story's pictures. Specs:
  `erasure`, `images`, housekeeping's `housekeeping`.

### Stories (`schema-04-stories.surql`)

- **`story`: one table (R11), its content only.** `currentStatus` points at its newest status
  entry (none = draft); `image: {file, alt}` and `mediaFile` point at its `storyFile` rows.
  - **Read:** the owner; api-admin, workflow, housekeeping all rows; everyone else (the public,
    api-user's login, other people) only stories whose current entry is `approved`, and only the
    published fields. Private fields (`submitter`, the sharing consent and its date, `createdAt`)
    are the owner's and those services' only; api-user reads `submitter` only once the owner is
    erased (erasure's delete needs it). Housekeeping never reads the words (`slug`, `title`,
    `description`, `body`, `bylineName`, `image.alt`).
  - **Create:** the person's own draft, live, after agreeing to the latest terms of use and
    testimony consent (`story_agreements`). `version` and `createdAt` are the server's.
  - **Write scope (D41), dropped silently outside it:** content fields only by the person, and
    only while `draft` or `changes_requested` (`story_owner_content_lock`); never api-admin or
    workflow. File pointers only through a new `storyFile` row (`storyFile_attach`, api-user's
    login), except that the person may take their picture off or change its description.
    `currentStatus` only through the status log's event. `submitter` is `READONLY` (an error).
    `updatedAt` is the server's time except for system users.
  - **Shape (D53, `fn::story::shape_problem`, event `story_shape`):** `written` needs non-blank
    text and no video or audio, may have a picture; `video`/`audio` hold exactly one file of their
    format from submit on, and may also have a picture (an audio story's picture, a video's own
    thumbnail). Pixel sizes positive, never beyond 1:3 or 3:1
    (`fn::shape::allowed`). Specs: `story-shape`.
  - **Limits (D94, D112, D113; `story_limits`, `story_text_limits`).** On the person's own writes
    only: no new draft over the open-drafts limit (`limit_open_drafts:`); no first submission before
    `fn::story::next_submission_at` (`limit_weekly_submission:`). Whoever writes (system users and
    the migrator included): text over `storyTextMax` refused
    only when it gets longer (`story_text_too_long:`); at submit the text length and
    `themesMin`–`themesMax` themes, every one still existing (`story_text_too_short`,
    `story_theme_count:`, `story_themes_changed:`). No grandfathering (Joel, 2026-10-30): every
    later action meets the limits in force. A story already submitted is never re-checked. Hard
    ceilings: 50,000 characters, 20 themes. Limits are anti-spam controls, not invariants: a write
    in flight when a setting changes may finish under the old values. Specs: `submission-limits`,
    `themes`, api-user's `stories`.
  - **Approval (A2, `story_approval_media`; `story_approval_testimony`):** refused unless every
    file is `ready` with its sizes and length (`fn::story::approval_problem`; `media_not_ready:`,
    api-admin `409`) and the submitter has a testimony consent (any version). Specs:
    `media-processing`, `agreements`.
  - **Delete:** erasure (api-user, api-admin); the owner, live, for `draft`, `changes_requested`,
    `withdrawn` or `rejected` (D71; never pending, in review, approved or hidden); housekeeping
    only for `fn::story::draft_expired(id)`: a draft untouched for 186 days
    (`fn::story::draft_retention`) since the later of `updatedAt` and its files' `renewedAt`. The
    owner's page shows the same `fn::story::draft_expires_at`. A delete takes the status log and
    others' hearts (`story_erasure_cascade`) and the search row (`story_search`), and queues the
    picture folder; its `storyFile` rows stay for the upload limits. Specs: `person-session`, api-user's `my-stories`, housekeeping's suite.
  - `themeIds` (text copies of `themeRefs`, computed) exists for the element index (gotchas).
    `slugHistory` keeps old slugs for a 301 (D30); only system users write it.
- **`storyStatusLog` (R6): one entry per change of status, append-only.** Fields: `story`,
  `status` (`pending`, `in_review`, `approved`, `changes_requested`, `rejected`, `withdrawn`,
  `hidden`), `actor` (set by the database: `person`, `moderator`, `system`), `by` (the person or
  moderator; api-admin alone reads it), `storyVersion`, `comment`, `at` (server time),
  `publishedAt` (approved entries: the first approval's time, kept on later ones), `hiddenReason`
  (`media_unavailable`, `media_changed`), `reviewedMediaFile`/`reviewedImageFile` (approved
  entries: the files approved).
  - **Read:** the owner (never `by`) and api-admin; everyone else only an entry's `story`,
    `status` and `publishedAt`, while it is its story's current approved entry.
  - **Create:** the owner, live, or api-admin. `storyStatusLog_step` checks who may take which
    step: the owner submits (from draft or changes requested) and withdraws (from anything but
    withdrawn); a moderator (api-admin, naming `by`) picks up, decides, hides and shows again; the
    system hides and shows again for media. The same write moves `story.currentStatus`, so the
    story's own events (shape, limits, agreements, approval gate) check the step too. No update;
    no delete while its story exists. Specs: `person-session`, `write-scope`, `public-view`.
  - `fn::story::status_of($s)` (`currentStatus.status ?? 'draft'`) is the status every rule and
    event asks. App code uses `STORY_STATUS`, `IS_DRAFT` and `isPublished` from `libs/database`
    (`story-status.ts`), never the convention itself.
- **Hiding for media (Joel, 2026-10-23; `fn::story::check_files`).** Whenever a story's file row or
  pointer changes: an approved story whose files have a problem gets a system `hidden` entry
  (`media_unavailable`), or one whose pointers aren't the reviewed files (`media_changed`). A
  story the system hid comes back (a system `approved` entry, first `publishedAt` kept) only while
  it points at both reviewed files, they are ready, and the person still has testimony consent.
  The owner sees a hidden story as published (api-user's `OWNER_STATUS_FIELDS`). Runbook:
  [media-runbook.md](media-runbook.md). Specs: `media-processing`.
- **`storyFile` (R12): one row per uploaded file.** Id = the Bunny video id or the picture's path
  (`stories/<story id>/<32 hex>.webp`, `fn::media::own_image`; dev-seed's `dev-seed/<name>.webp`
  only for system users).
  - **Read:** the person their own; api-user, api-admin, workflow, housekeeping all; everyone else
    the id, `format`, `width`, `height`, `lengthSeconds` and `thumbnailPath`, of a file an approved
    story points at now.
  - **Create:** only api-user's login. `storyFile_attach` (elevated) checks the story is the
    person's, editable, at `storyVersion` (`story_cmd:stale_version`), of that format
    (`upload_refused:`), the upload limits (`limit_upload_size|duration|hourly|weekly:`; a picture
    doesn't count towards the weekly limit) and, for a picture, that the story still shows
    `expectedImage` (`image_changed:`). It then points the draft at the file. `story_files` refuses
    a pointer to a row of another story, another kind or detached (`media_not_granted`; system
    users exempt), and marks the replaced row `detachedAt`.
  - **Update:** workflow the processing fields (`width`, `height`, `lengthSeconds`,
    `thumbnailPath`, `processing`); api-user `renewedAt` (server time, through `fn::upload::renew`,
    which refuses unless the story still exists, is the person's, is editable and shows that file:
    `nothing_to_resume:`); events `detachedAt`; housekeeping `removedAt` (once, not before
    `fn::upload::links_expire_after()`, 2 h: `file_not_removable`).
  - **Delete:** api-user (erasure); housekeeping a row older than 7 days whose file is removed or
    whose story is gone. Counted from these rows, so replacing a file or deleting a story frees no
    upload limit. Specs: `uploads`, `images`, api-user's `uploads`, housekeeping's suite.
- **`storySearch`** (search option A, Joel 2026-11-06): one row per published story (`story`,
  `searchText`: title, description, written text and its themes' current names), full-text index
  `storySearch_fts`. Everyone reads a row only while its story's current entry is `approved`;
  only events write it (`story_search`, `storySearch_theme_renamed`, via `fn::story::sync_search`).
  Its own table because BM25 counts every indexed row: drafts in the index moved published
  stories' scores. Specs: `story-search`.

### Themes (`schema-03-themes.surql`; themes plan v3)

- `themeCategory {name}`, `theme {name, category, highlighted}`, `themeCatalog:current {version,
changedBy, changedByRole}`. Everyone reads them; only api-admin's login writes them (naming the
  admin on `themeCatalog`); nobody deletes `themeCatalog`. api-admin tidies names and checks
  duplicates, not the database.
- `themeCategory:other` can't be renamed or deleted, by anyone; deleting another category moves its
  themes to Other, not highlighted (`themeCategory_delete`).
- `theme_delete` takes the theme off every story (no consent needed, passes the content lock); a
  story left under `themesMin` is checked only at its next submit. A theme delete and a story
  write adding that theme bump `fence:theme-<id>`, so they can't both commit. Specs: `themes`,
  api-admin's `themes`.

### Legal texts and agreements (`schema-05-legal-texts.surql`; plan 4e)

- `termsOfUseAgreement`, `testimonyConsent`, `socialMediaSharingConsent`, `privacyNotice`: id = the
  version number from 0, `content` (Markdown), `release_date` (the database's), `publishedBy` (the
  admin; api-admin and system users read it). Everyone reads them, the public included. Only
  api-admin's login creates them, only the next number (`legal_version_number`), and with
  `publishedBy` (`legal_published_by`; system users may omit it). Nobody changes or deletes one,
  the migrator included (`<table>_kept`): a mistake is fixed with a new version. Data 0009 seeds
  version 0 where none exists.
- **Pointers** `user.termsOfUse`, `user.testimonyConsent`, `story.socialMediaSharingConsent`, each
  with its `…AgreedAt` (the database's time). `fn::legal::check_pointer`: only the person's own
  session moves one (`agreement_not_own`), only to the latest version
  (`agreement_version_changed`), never cleared (`agreement_kept`) except by erasure or deleting the
  story. System users load data as given.
- **Agree first:** creating, editing or submitting a story and an upload made for the person need
  the latest terms of use and testimony consent (`terms_agreement_required`,
  `testimony_consent_required`); a heart needs the latest terms. Withdrawing, deleting and erasure
  need nothing. Specs: `agreements`.

### Settings and limits (`schema-06-settings-and-logs.surql`)

- **`submissionSettings:current`**: everyone reads; only api-admin's login writes (with
  `changedBy`, `changedByRole`); nobody deletes; min ≤ max checked (`submissionSettings_check`).
  `fn::settings::submission()` fills defaults; `fn::settings::upload_ceilings()` caps uploads
  (10 GiB video, 2 GiB audio, 3 h), which is also what trusted people get.
- **`submitterLimits:<user id>`** (D112): `trusted` and optional overrides. The person reads their
  own; api-user and api-admin read; only api-admin writes (naming the admin; a reset is an update,
  so it says who); only api-user deletes (erasure). `devSeed` rows are refused outside dev.
  `fn::limits::effective($user)` is the one definition of what applies.
- **`submissionLog`** (D113): one row per first submission, written and pruned to 7 days by
  `story_limits` only, no story link (deleting a story doesn't free the week). The person reads
  their own; api-user deletes at erasure.
- **`idempotencyKey`**: id `[service, user record | 'svix' | 'stripe', key]`. api-user and api-admin
  read and write all; a person creates and reads only `['api-user', $auth, …]` (live), never updates
  or deletes, so the command, key and stored response commit in one transaction (`runIdempotent`).
  Housekeeping reads and deletes only expired keys. Specs: `person-session`, the `idempotency`
  unit spec, housekeeping's suite.

### System (`schema-01-system.surql`)

- `_migration`, `_migrationRun`, `_migrationPending`, `_migrationReset`, `_identity`, `service`,
  `fence`: `PERMISSIONS NONE`. `_setting:current` (`environment`): everyone reads, nobody writes
  but system users. A row, not a `DEFINE PARAM` (gotchas).
- `fence`: `fence:person-<user id>`, `fence:identity-<sha256>`, `fence:theme-<theme id>`, bumped by
  events only through `fn::fence::touch`.

## Person-linked tables

Every table in the schema; `person-linked.int-spec.ts` fails if a new one isn't classified there
and here.

| Table             | Holds or links                                                                                                                          | Class  | On create/update                                                             | After erasure                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| `user`            | the person (Clerk id until erasure)                                                                                                     | root   | fence; binding and erasure rules (D37); `status` → `deleted` only by erasure | stub: id, `createdAt`, `status`                       |
| `story`           | testimony; `submitter`                                                                                                                  | linked | submitter live; owner and agreement rules                                    | deleted                                               |
| `storyStatusLog`  | a story's status history; `story`, `by`                                                                                                 | linked | step rules; submitter live (the pointer move)                                | deleted (cascade)                                     |
| `storySearch`     | a published story's words; `story`                                                                                                      | linked | events only, with the write that publishes or unpublishes the story          | deleted with the story                                |
| `storyFile`       | one uploaded file; `person`, `story`                                                                                                    | linked | created by api-user, processed by workflow, cleaned by housekeeping; live    | deleted                                               |
| `favourite`       | a heart; `person`, `story`                                                                                                              | linked | person and story owner live; latest terms; story public                      | deleted                                               |
| `idempotencyKey`  | `[service, user record, key]`; `{id, version}`                                                                                          | linked | user live (webhook keys exempt); people: own keys only                       | deleted; any key deleted by housekeeping once expired |
| `submitterLimits` | per-person limits and trusted mark; `user`, `changedBy`                                                                                 | linked | user live; `changedBy` required from api-admin; `devSeed` dev only           | deleted                                               |
| `submissionLog`   | recent first submissions; `person`                                                                                                      | linked | written by `story_limits` only; person live                                  | deleted                                               |
| `fence`           | counters                                                                                                                                | none   | events only; `PERMISSIONS NONE`                                              | stays (no data)                                       |
| `erasedIdentity`  | sha256 of an erased Clerk id (D82): pseudonymous; no link, no date                                                                      | kept   | api-user creates and reads; nobody updates or deletes                        | kept for ever                                         |
| `pendingDeletion` | Bunny ids, deleted stories' folders, a Clerk id until deleted (D40); no link                                                            | kept   | erasure and story deletes; api-user and housekeeping retry and delete        | gone once done, a folder after its final pass         |
| reference tables  | `submissionSettings`, `themeCategory`, `theme`, `themeCatalog`, the four legal texts, `service`, `_migration*`, `_identity`, `_setting` | none   | —                                                                            | —                                                     |

- **Staff links.** `storyStatusLog.by`, the legal texts' `publishedBy` and the settings' and
  themes' `changedBy` point at staff `user` rows, which become stubs like anyone's.
- **A new table** that holds or links person data calls `fn::person::live` on create/update, bumps
  the fence on delete, and is classified in the spec and here.

## Erasure

`fn::account::erase` (`schema-02-people.surql`) is the one erasure, run on **api-user's own login**
in one transaction (`ERASE_ACCOUNT`, `libs/database/src/lib/erasure.ts`), for "Delete my account"
(`DELETE /v1/account`, the person's withdrawal of consent) and Clerk's `user.deleted` webhook (Svix
signature, deduplicated on `svix-id`). Both answer `202`. In order:

1. The tombstone (`erasedIdentity`), even for a Clerk id with no row.
2. `pendingDeletion` rows for the person's video and audio files not yet removed, and the Clerk
   account unless Clerk started it.
3. The user row becomes a stub (`status = 'deleted'`, no Clerk id, no agreements), which deletes
   their hearts. This comes first because api-user may read a story's `submitter` only once its
   owner is erased.
4. Their stories (the cascade takes status logs, search rows and others' hearts; each delete queues
   its picture folder), idempotency keys, `submitterLimits`, `submissionLog` and `storyFile` rows.

After the commit api-user drains the queue (Bunny, picture folders, Clerk last, which ends their
sessions); a failure waits with backoff for the nightly housekeeping, and the answer is still `202`.
What remains: the stub (id, `createdAt`, `status`) and the tombstone. There is no audit log
(database review 2): who changed something last is on that row (`changedBy`, `publishedBy`). Each
erasure logs internal ids only, which the restore runbook replays; backups age out after
`backup_retention_days`.

- **Race-safe for the linked tables only:** a write for an erased person is refused, even from a
  session opened before; a write overlapping erasure fails at commit; erasure losing that race is
  retried. Bunny and Clerk are application ordering (D39/D40).
- **Accepted risk (D13):** a compromised api-user login can erase anyone (destructive, not a
  disclosure); the backup restores it and the erasure log keeps erased people erased.

Specs: `erasure`, `person-linked`, `concurrency`, api-user's `erasure`, `libs/auth`'s
`clerk-session`.

## Transactions, conflicts and retries

- **Snapshot reads.** A transaction sees the database as it was when it began, so a check in a
  permission or event can pass while another transaction commits the opposite. Only write-write
  conflicts abort. So every write that depends on or changes a person bumps
  `fence:person-<id>` (events run elevated, so no session needs rights on `fence`), and of two
  overlapping ones the second to commit fails: `Transaction conflict: … This transaction can be
retried`. One fence per person: unrelated people never conflict. The same goes for a Clerk id
  (`fence:identity-…`) and a theme (`fence:theme-…`).
- **Retry the whole command** (re-read, re-check, re-write) with a small bounded backoff
  (`retryOnConflict`, `isTransactionConflict` in `libs/database`: 3 attempts, 4 with an
  `Idempotency-Key`). The retry sees the committed state, so a newer legal version or an erasure
  now refuses it.
- **Erasure retries until it commits** (D39 makes it idempotent) and then erases the write that
  beat it.
- **Expected conflicts:** a moderator approving while the person edits, two tabs of one person, a
  file failing while a moderator approves, two admins saving the themes or the same legal version.
- **Handle three outcomes:** rules in events throw errors (codes the APIs map); permissions give
  empty results or dropped fields; overlaps give a retryable conflict. Check what you wrote with
  `requireWritten` (it only works on tables the caller can read back).

## SurrealDB 3.2.4 gotchas

Found in testing from 2026-10-18. Where a test pins one, it's named; the rest are relied on by
the schema and caught only by review.

**Permissions and sessions**

- A write the permissions deny returns an empty result, not an error; so does an allowed write on
  a table the caller can't read back (api-user's `DELETE … RETURN BEFORE` on stories returns `[]`).
  Field permissions drop silently; a `READONLY` change and an event `THROW` are errors.
  (`write-scope`, `service-permissions`)
- For a `service` session `$auth.id` is NONE in queries (the `service` table is
  `PERMISSIONS NONE`), and `SELECT count() FROM t GROUP ALL` with no WHERE skips a row rule that
  reads `$auth.id`. So every rule and query compares `$auth` itself (`submitter = $auth`,
  `$auth IN [service:…]`). (`public-view` counts every readable table without a WHERE)
- Events run with elevated privileges: an event fired by a person's write can write a
  `PERMISSIONS NONE` table. Events are trusted code; keep them small and deliberate.
- A function runs with the caller's permissions in queries and permission clauses (so it sees
  nothing the caller can't: fail closed), but elevated inside events.
- Row and field rules can follow links both ways without recursing (the story's rule reads
  `currentStatus.status`, the entry's rule reads `story.currentStatus`). (`public-view`)
- In a person's session, a projection aliased `id` (`<string> id AS id`) changed what `id` meant to
  the other fields of a query with subqueries and ORDER BY: api-user's story reads alias it
  `storyRef`. ORDER BY needs the ordered field selected under its own name.
- `REMOVE USER` doesn't end that user's open sessions: the cutover is a restart
  (`infra/k8s/surrealdb/README.md`). (`migration`)

**Fields and values**

- `$auth` is usable in a field `VALUE`.
- `DEFAULT` accepts a client-supplied value; server-controlled fields use `VALUE` (… `READONLY`).
- A field `VALUE` also runs for a nested `SET` (`SET a.b = …`), with `$value` the whole new
  field and `$before` the old one.
- Inside a SELECT in a field's `VALUE`, `$this` is the row that SELECT reads, not the record being
  written: bind it first (`LET $story = $this.story`; `storyStatusLog.publishedAt`). (`public-view`
  checks each story keeps its own `publishedAt`)
- Inside a subquery, a computed field's `$parent` is the outer query's record: computed fields use
  their own record's fields directly, never `$parent`.
- `array<object>` items store undefined keys (nested objects refuse them), and `REMOVE FIELD` keeps
  stored values: check keys explicitly, clean up with a data script.
- Inside a function a caller's bound variable shadows a `DEFINE PARAM`: nothing a caller mustn't
  control lives in a param (`_setting:current` is a row).
- `string::trim` keeps U+FEFF (JavaScript's `trim()` strips it) and strips U+0085 (JavaScript
  keeps it): `fn::text::trimmed_length` and `trimmedTextLength` agree on both. (`story-shape`)

**Queries and indexes**

- An element index over record links (`themeRefs.*`) makes `CONTAINS` return no rows; over strings
  it works: hence `story.themeIds`.
- A query inside a closure (`$list.filter(|$x| …)`) iterates the whole table, never an index:
  `/v1/themes` sends its probes as top-level statements.
- A correlated subquery with `ORDER BY … LIMIT 1` returns wrong rows: use
  `array::last(… ORDER BY … ASC)` or `array::min`.
- Left to itself the planner may pick the wrong index (`storyStatusLog.publishedAt` names
  `WITH INDEX storyStatusLog_story`); `EXPLAIN` on a local database before trusting a plan.
- Re-defining a full-text index over rows can make the COMMIT fail with a retryable conflict: the
  migration runner retries such a step.

**Transactions and scripts** (`migration` pins each)

- A `RETURN` inside a transaction commits it early and skips the rest, wherever it hides
  (`[RETURN 1]`, `1 + RETURN 1`, `IF … THEN RETURN … END`, blocks). `BREAK`/`CONTINUE` in an `IF`
  or `FOR` block skip the rest of that block while the transaction commits. Inside a function,
  event, field or param body neither affects the caller. So data scripts follow an allow-list and
  may not contain these words, schema files are DDL only, and every step ends with its marker, is
  count-checked, and counts as rolled back only when the server refused its `COMMIT`.
- Comments end at U+0085, U+2028 and U+2029 too, so bundled files contain no control or separator
  characters and only ASCII outside strings. `/'/` is a regex literal and `r""`, `u''`, `d''`,
  `b""`, `s''` are prefixed strings: the runner refuses both, and each step ends with a nonce it
  must get back.
- A bare record path (`table:id.field`) in an `IF` fails ("Specify a database to use"): `LET` it
  first. `FOR $x IN (SELECT …)` fails: `LET` the rows, then loop. `SLEEP` needs root.
- A startup `--import-file` with `OPTION IMPORT` hangs the server, and a failing statement in it is
  only logged. `surreal import` requires `OPTION IMPORT`, which switches off events and field
  `VALUE`/`ASSERT`, so the runner uses `/rpc`.
- In a failed transaction, surrealdb.js 2.0.x's `collect()` throws "not executed due to a failed
  transaction", not the `THROW`: `runQuery` reads `.responses()` for the root cause
  (fixed in 2.1.0, surrealdb.js#689).

## Per-request person sessions (surrealdb.js)

api-user keeps one long-lived WebSocket connection per instance, signed in as
`service:api_user`, and opens a session per request (`withPersonSession` in `libs/database`, used
by `PersonSessions` in `libs/auth`):

```ts
const session = await connection.newSession(); // fresh: no identity at all
try {
  await session.authenticate(clerkToken); // throws if rejected; ns/db come from the token
  return await work(session);
} finally {
  await session.invalidate(); // 2.0.8: cancels the renewal timer
  await session.closeSession(); // detaches the session on the server
}
```

- **Never authenticate a shared session** (or the connection): requests interleave, and A's query
  runs as B.
- **Use `newSession()`, never `forkSession()`:** a fork inherits the service login, and if the
  person's token is then rejected it keeps running as `service:api_user`. A rejected token on a
  new session can run nothing. (`request-sessions` checks the safe pattern: isolated, cleaned up.)
- **2.0.8 renewal-timer leak:** a session closed without `invalidate()` keeps its renewal timer and
  later emits `error` on the connection (fixed in 2.1.0, surrealdb.js#688).
- **Service sign-in** uses record access (`access: 'svc'`, `serviceSignIn`) so the SDK signs in
  again after reconnects and the 15-minute token expiry; 2.0.8's types don't cover it.
- One socket handles an instance's concurrency (requests are multiplexed). A session costs 4 extra
  round trips (about 2 ms locally); surrealdb.js ≥ 2.1.1's `.as(token)` over HTTP is a stateless
  alternative for simple reads, but has no interactive transactions.

## Clerk side

SurrealDB needs `ns`, `db` and `ac` claims, signed RS256 by a key it holds. GKE has no egress, so
OpenTofu pins the PEM (`clerk_jwt_public_key` in
`infra/terraform/live/dev/cluster/clerk.auto.tfvars`); there's no JWKS URL. Empty, the migration
removes `DEFINE ACCESS clerk`, so no token opens a person session.

- The default session token carries `{ "ns": "heisreal", "db": "main", "ac": "clerk", "role": … }`
  (`infra/clerk/dev.json`), so one token serves api-user's guard and SurrealDB. JWT templates were
  the fallback; not needed.
- api-user and api-admin verify the token before it reaches SurrealDB (signature,
  `exp`/`nbf`/`iat`, `iss`, `azp`, role). **SurrealDB checks neither `iss` nor `azp`:** the pinned
  key alone ties tokens to the instance, so dev and prod keys must differ (they do).
- Rejected by SurrealDB (`person-session`): expired, wrong key, `ac` = `svc` or unknown, unknown
  `sub`, other database, no `exp`, HS256 with the public key, tampered payload, erased person; an
  `id` claim can't override `AUTHENTICATE`.
- api-user creates the person's `user` row on first use (`provisionPerson`). Key rotation:
  `infra/clerk/README.md`.

## Remaining risks

- **Reconnects are untested** (the harness uses `reconnect: false`). To check against a restarted
  SurrealDB: sessions re-attach; a person session whose token expired meanwhile ends up
  invalidated, not running as the service; in-flight requests fail cleanly; the service connection
  signs in again.
- **A session opened before erasure can still read** the person's remaining rows until its token
  expires; writes are refused or conflict.
- **Editing an approved story** needs a revision → re-approval flow (M3) before published words
  change: the public reads the story itself.
- **OWNER can still remove the guard events.** The migrator and the backup (VIEWER, reads
  everything) are trusted in-cluster system users.
- **Engine upgrades:** the gotchas without a pinning test above could change silently on a
  SurrealDB upgrade; re-check them then.
- Not yet proven on dev: Clerk's real `user.deleted` delivery, and clock skew between Clerk and the
  cluster (Clerk tokens live 60 s with `nbf` 5 s in the past).
