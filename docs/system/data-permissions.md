# Data permissions: people, themes, legal texts, settings and system tables

Covers: who may read and write the tables in `schema-01`, `-02`, `-03`, `-05` and `-06`; logins and person data are in [data-model.md](data-model.md).
Data: `libs/database/schema` is the source of truth.
Next id: REQ-DBP-063

## Contents

- People (`schema-02-people.surql`)
- Staff and block list (`schema-02-people.surql`)
- Themes (`schema-03-themes.surql`)
- Legal texts and agreements (`schema-05-legal-texts.surql`)
- Settings and limits (`schema-06-settings-and-logs.surql`)
- System (`schema-01-system.surql`)

## People (`schema-02-people.surql`)

- **REQ-DBP-001** A person reads their own `user` row; api-user, api-admin and workflow read all rows. [D13]
- **REQ-DBP-002** Only api-user's login creates a `user` row, on the person's first use (`provisionPerson`). [D13]
- **REQ-DBP-003** api-user and api-admin update `user` rows (erasure; api-admin's legacy link), and the person's own session updates only their agreement pointers (`user_agreements`); nobody deletes a `user` row. [D13]
- **REQ-DBP-004** `clerkUserId` changes only from `NONE` to an id for a live user (not by api-user) or from an id to `NONE` by erasure (`user_clerk_binding`, `user_erasure_final`, on create too). [D37]
- **REQ-DBP-005** `user.status` is `active` or `deleted`: erasure sets it and it never goes back, and every "is this person erased?" rule asks `status = 'deleted'`. [D37]
- **REQ-DBP-006** A heart is a `favourite` row with id `favourite:<ulid>`, made within 5 s of now (`fn::favourite::made_now`, so none is backdated), one per person and story. [R14]
- **REQ-DBP-007** Only the person reads, creates and deletes their own hearts and nobody updates one; no service login reads them, nor does the story's owner. [J-2026-10-25-DB]
- **REQ-DBP-008** A new heart needs a live person, fences the story's owner too, and needs the latest terms of use and a story published now (`favourite_rules`). [J-2026-10-25-DB]
- **REQ-DBP-009** A story that stops being public keeps its hearts; lists read only public stories, so it drops out of them. [J-2026-10-25-DB]
- **REQ-DBP-010** Erasure deletes the person's hearts (`user_erasure_favourites`), and a story's delete takes its hearts. [D39]
- **REQ-DBP-011** The owner's count of hearts per story is a counter the `favourite_rules` event keeps in its own table, never on the story, readable by the owner only: a number, never who. (planned) [J-2026-10-25-DB]
  Why: a person can't count others' rows, and a counter on the story would bump its `version`.
- **REQ-DBP-012** `erasedIdentity` (the tombstone) has id = sha256 of the Clerk user id and nothing else; only api-user's login reads or creates it, and nobody updates or deletes it. [D82]
- **REQ-DBP-013** `user_not_erased_identity` refuses an erased Clerk id on any `user` create or update. [D82]
- **REQ-DBP-014** The tombstone is a retained identity fingerprint (pseudonymous personal data, not anonymous), kept so a deleted sign-in can't come back; the privacy policy must say so. [D82]
- **REQ-DBP-015** `pendingDeletion` holds what must still go outside the database: `bunny_video`, `image` (a deleted story's folder `stories/<story id>/`) and `clerk_user`, with no person link. [D40]
- **REQ-DBP-016** api-user creates `pendingDeletion` rows (never `image`); a story's delete queues its folder (`story_picture_folder`, keyed `pendingDeletion:⟨image-<story id>⟩`, from the story row, whoever deletes it). [D40]
- **REQ-DBP-017** api-user and housekeeping read `pendingDeletion` rows, update `attempts` and `nextAttemptAt` (`fn::erasure::retry_after`: 1 h, doubling, at most a week) and delete rows. [D40]
- **REQ-DBP-018** A folder row can't be deleted before its `finalPassAt`, 15 min after the delete (`fn::erasure::final_pass_after`). [D40]
  Why: a picture PUT link signed just before the delete lives 10 minutes.
- **REQ-DBP-019** A story can't be created while its folder row is still queued (except by a system user), so an old row never deletes a new story's pictures. [D40]

Tests: `person-session`, `erasure`, `service-permissions`, `favourites`, `images`, api-user's
`favourites`, housekeeping's `housekeeping`.

## Staff and block list (`schema-02-people.surql`)

- **REQ-DBP-020** `staffMember` (the Staff page's list) has id = the email, lower-case (`staffMember:⟨ann@heisreal.today⟩`), and `email` (the same, `@heisreal.today` only), `role` (`Moderator` or `Admin`), `addedBy` and `addedAt`. [S-1]
- **REQ-DBP-021** `staffMember.addedBy` is the adding Admin's email from their token, set once; NONE means the deploy's baseline step. [S-4]
- **REQ-DBP-022** Only api-admin's login reads, creates, updates and deletes `staffMember` rows (it checks the caller is an Admin); no other service sees the table. [S-1]
- **REQ-DBP-023** Roles live in Clerk: no authorization reads `staffMember`. [G8]
- **REQ-DBP-024** Removing or demoting the last `Admin` row is refused (`staffMember_last_admin`, `staff:last_admin`), and each such change bumps `fence:staff-admins`, so of two overlapping removals of the last two Admins the second conflicts. [S-1]
- **REQ-DBP-025** System users are exempt from the last-Admin rule (wiping dev data). [S-1]
- **REQ-DBP-026** Staff work emails are not story data: `staffMember` is not linked to `user` and is not on the erasure checklist. [S-1]
- **REQ-DBP-027** `blockedEmail` and `blockedIp` (the block list) have id = the value, lower-case (`blockedEmail:⟨spam@example.com⟩`; `blockedIp:⟨203.0.113.7⟩`, IPv6 in its short form as api-admin writes it, `canonicalIp` in `libs/http`). [G21]
- **REQ-DBP-028** A block-list row holds `email` or `ip` (the same value; a valid email, `string::is_email`, or IP address, `string::is_ip`), `addedBy`, `addedAt` and `note`. [G21]
- **REQ-DBP-029** A block-list row's `addedBy` is the adding Admin's email from their token, required from any session; it is NONE only from a system user. [G21]
- **REQ-DBP-030** A block-list row's `note` (why it is blocked) is optional: trimmed, 1–500 characters, or NONE. [BN-2]
- **REQ-DBP-031** api-admin's login reads, creates, deletes and updates block-list rows (it checks the caller is an Admin); an update changes only `note`, and the value, `addedBy` and `addedAt` are read-only, with no record of who edited it. [BN-4]
- **REQ-DBP-032** `note` has its own field permission: only api-admin reads or writes it. [BN-6]
- **REQ-DBP-033** api-user may read one block-list row it names: the rule is `email = $blockCheck` or `ip = $blockCheck`, the query's own parameter. [G21]
  Why: api-user asks whether one email or address is blocked (at first call and story send), never listing them or seeing a note.
- **REQ-DBP-034** No other service or person reads `blockedEmail` or `blockedIp`. [G21]
- **REQ-DBP-035** Block-list rows are not linked to `user` and are kept after erasure on purpose: a block is permanent until an Admin removes it. [G21]

Tests: `staff`, `block-list`, api-admin's `staff` and `block-list`, api-user's `account` and `stories`.

## Themes (`schema-03-themes.surql`)

- **REQ-DBP-036** `themeCategory {name}`, `theme {name, category, highlighted}` and `themeCatalog:current {version, changedBy, changedByRole}`: everyone reads them, only api-admin's login writes them (naming the admin on `themeCatalog`), and nobody deletes `themeCatalog`. [J-2026-10-31-DB]
- **REQ-DBP-037** api-admin tidies theme names and checks duplicates, not the database. [A4]
- **REQ-DBP-038** `themeCategory:other` can't be renamed or deleted, by anyone; deleting another category moves its themes to Other, not highlighted (`themeCategory_delete`). [J-2026-10-31-DB]
- **REQ-DBP-039** `theme_delete` takes the theme off every story (no consent needed, passes the content lock); a story left under `themesMin` is checked only at its next submit. [A9]
- **REQ-DBP-040** A theme delete and a story write adding that theme both bump `fence:theme-<id>`, so they can't both commit. [R5]

Tests: `themes`, api-admin's `themes`.

## Legal texts and agreements (`schema-05-legal-texts.surql`)

- **REQ-DBP-041** `termsOfUseAgreement`, `testimonyConsent`, `socialMediaSharingConsent` and `privacyNotice` rows have id = the version number from 0, `content` (Markdown), `release_date` (the database's) and `publishedBy` (the admin; api-admin and system users read it). [J-2026-11-01-DB]
- **REQ-DBP-042** Everyone reads the legal texts, the public included; only api-admin's login creates them, only the next number (`legal_version_number`), and with `publishedBy` (`legal_published_by`; system users may omit it). [J-2026-11-01-DB]
- **REQ-DBP-043** Nobody changes or deletes a legal text version, the migrator included (`<table>_kept`): a mistake is fixed with a new version. [J-2026-11-01-DB]
- **REQ-DBP-044** Data script 0009 seeds version 0 of each legal text where none exists. [J-2026-11-01-DB]
- **REQ-DBP-045** The pointers `user.termsOfUse`, `user.testimonyConsent` and `story.socialMediaSharingConsent` each have an `…AgreedAt`, the database's time. [J-2026-11-01-DB]
- **REQ-DBP-046** `fn::legal::check_pointer`: only the person's own session moves a pointer (`agreement_not_own`), only to the latest version (`agreement_version_changed`), and never clears one (`agreement_kept`) except by erasure or deleting the story. [J-2026-11-01-DB]
- **REQ-DBP-047** System users load agreement pointers as given. [J-2026-11-01-DB]
- **REQ-DBP-048** Creating, editing or submitting a story, and an upload made for the person, need the latest terms of use and testimony consent (`terms_agreement_required`, `testimony_consent_required`); a heart needs the latest terms. [J-2026-11-01-DB]
- **REQ-DBP-049** Withdrawing, deleting and erasure need no agreement. [J-2026-11-01-DB]

Tests: `agreements`.

## Settings and limits (`schema-06-settings-and-logs.surql`)

- **REQ-DBP-050** `submissionSettings:current`: everyone reads, only api-admin's login writes (with `changedBy`, `changedByRole`), nobody deletes, and min ≤ max is checked (`submissionSettings_check`). [J-2026-10-28-DB]
- **REQ-DBP-051** `submissionSettings:current` also holds housekeeping's two deletion times, `rejectedRetentionDays` and `editingRetentionDays`, each 7 to 3,650 days. [G3]
- **REQ-DBP-052** `fn::settings::submission()` fills defaults; `fn::settings::upload_ceilings()` caps uploads (10 GiB video, 2 GiB audio, 3 h), which is also what trusted people get. [J-2026-10-28-DB]
- **REQ-DBP-053** `imageMaxBytes` (200 KiB to 20 MiB, 3 MiB by default) is the largest picture file for everyone, trusted too; `fn::upload::image_limits()` reads it for `storyFile_attach`. [J-2026-11-20-DB]
- **REQ-DBP-054** `submitterLimits:<user id>` holds `trusted` and optional overrides: the person reads their own, api-user and api-admin read, only api-admin writes (naming the admin; a reset is an update, so it says who), and only api-user deletes (erasure). [D112]
- **REQ-DBP-055** `submitterLimits` rows marked `devSeed` are refused outside dev, and `fn::limits::effective($user)` is the one definition of what applies. [D112]
- **REQ-DBP-056** `submissionLog` holds one row per first submission, written and pruned to 7 days by `story_limits` only, with no story link, so deleting a story doesn't free the week. [D113]
- **REQ-DBP-057** The person reads their own `submissionLog` rows; api-user deletes them at erasure. [D113]
- **REQ-DBP-058** `idempotencyKey` has id `[service, user record | 'svix' | 'stripe', key]`: api-user and api-admin read and write all, and a person creates and reads only `['api-user', $auth, …]` (live) and never updates or deletes. [D29]
  Why: so the command, the key and the stored response commit in one transaction (`runIdempotent`).
- **REQ-DBP-059** Housekeeping reads and deletes only expired `idempotencyKey` rows. [R4]

Tests: `person-session`, the `idempotency` unit spec, housekeeping's suite.

## System (`schema-01-system.surql`)

- **REQ-DBP-060** `_migration`, `_migrationRun`, `_migrationPending`, `_migrationReset`, `_identity`, `service` and `fence` are `PERMISSIONS NONE`. [D13]
- **REQ-DBP-061** `_setting:current` (`environment`): everyone reads and only system users write; it is a row, not a `DEFINE PARAM` (REQ-DBE-016). [D49]
- **REQ-DBP-062** The fences are `fence:person-<user id>`, `fence:identity-<sha256>` and `fence:theme-<theme id>`, bumped by events only, through `fn::fence::touch`. [R5]
