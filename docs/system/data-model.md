# Data model: logins, person data, erasure and transactions

Covers: who connects to SurrealDB, which tables hold person data, erasure, transactions and retries.
Data: the schema in `libs/database/schema` is the source of truth; its comments give the field-level detail.
Next id: REQ-DB-038

## Contents

- Where things are
- Who connects
- Person-linked tables
- Erasure
- Transactions, conflicts and retries

Per-table permissions: [data-permissions.md](data-permissions.md) (people, themes, legal texts,
settings, system), [data-stories.md](data-stories.md) (`story`),
[data-story-log.md](data-story-log.md) (`storyStatusLog`), [data-media.md](data-media.md)
(`storyFile`, `mediaJob`, `storySearch`, public lists). Engine behaviour, sessions and Clerk:
[data-engine.md](data-engine.md).

## Where things are

The cluster runs SurrealDB v3.2.4 (the digest in `infra/k8s/surrealdb/base/kustomization.yaml`);
the services use surrealdb.js 2.0.8. Schema files `libs/database/schema/schema-0N-*.surql` (one per
area, applied in name order as one step), `access-clerk.surql`, run-once data scripts in
`schema/data/000N-*.surql`, the runner `schema/migrate.py`, integration tests in
`libs/database/integration/*.int-spec.ts` (command in `libs/database/README.md`; Vitest's global setup starts the
pinned image on RocksDB).

- **REQ-DB-001** The schema files are declarative and the migrate Job and the integration tests both apply them with `migrate.py`. [D14]
- **REQ-DB-002** The schema sits under an Nx project, so a schema change makes it affected and CI runs its `test-integration`. [D14]
- **REQ-DB-003** Every denied-write test asserts the empty result and checks, through the migrator, that the row is unchanged or absent. [D13]

## Who connects

- **REQ-DB-004** System users (`$auth = NONE` in rules) are the `migrator` (OWNER, schema and data scripts), the backup (VIEWER) and, in dev only, `dev_seed` (EDITOR). [D14]
- **REQ-DB-005** `dev_seed` is created only when OpenTofu sets `dev_seed_login`, and its reset refuses unless `_setting:current` says dev. [D49]
- **REQ-DB-006** System users bypass permissions, but every event still runs. [D13]
- **REQ-DB-007** Many fields let a system user supply a value (times, `actor`, `updatedAt`) so data loads and tests can age rows. [D49]
- **REQ-DB-008** Services sign in with record access `svc` as a `service` record: `service:api_public_read` (read-only), `api_user`, `api_admin`, `workflow`, `housekeeping`. [D13]
- **REQ-DB-009** Service passwords come from Secret Manager; SurrealDB's startup init writes the hashes (`infra/k8s/surrealdb/base/init.surql.tmpl`). [D13]
- **REQ-DB-010** A person opens a session with their Clerk token (`DEFINE ACCESS clerk`, `sub` → `user` by `clerkUserId`), and their commands run in their own session, so the database checks ownership. [D27]
- **REQ-DB-011** Moderators and Admins act through api-admin's login, which names them (`by`, `changedBy`, `publishedBy`). [D13]
- **REQ-DB-012** Only the migrator can `DEFINE` or `REMOVE` anything: every service and person session is refused, and the guard events and functions survive the attempts. [D14]

Tests: `schema`, `service-permissions`, `person-session`.

## Person-linked tables

- **REQ-DB-013** Every table in the schema is classified in the table below and in `person-linked.int-spec.ts`, which fails when a table is not classified there. [D37]

| Table             | Holds or links                                                                                                                          | Class  | On create/update                                                             | After erasure                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `user`            | the person (Clerk id until erasure)                                                                                                     | root   | fence; binding and erasure rules (D37); `status` → `deleted` only by erasure | stub: id, `createdAt`, `status`                               |
| `story`           | testimony; `submitter`                                                                                                                  | linked | submitter live; owner and agreement rules                                    | deleted                                                       |
| `storyStatusLog`  | a story's status history; `story`, `by`, `senderIp` (30 days), `senderEmail`, `staffEmail`                                              | linked | step rules; submitter live (the pointer move)                                | deleted (cascade)                                             |
| `storySearch`     | a published story's words; `story`                                                                                                      | linked | events only, with the write that publishes or unpublishes the story          | deleted with the story                                        |
| `storyFile`       | one uploaded file; `person`, `story`                                                                                                    | linked | created by api-user, processed by workflow, cleaned by housekeeping; live    | deleted                                                       |
| `mediaJob`        | a media job about one file; `file`                                                                                                      | linked | api-user and workflow create; file's person live; one open per file and kind | deleted with the file                                         |
| `favourite`       | a heart; `person`, `story`                                                                                                              | linked | person and story owner live; latest terms; story public                      | deleted                                                       |
| `idempotencyKey`  | `[service, user record, key]`; `{id, version}`                                                                                          | linked | user live (webhook keys exempt); people: own keys only                       | deleted; any key deleted by housekeeping once expired         |
| `submitterLimits` | per-person limits and trusted mark; `user`, `changedBy`                                                                                 | linked | user live; `changedBy` required from api-admin; `devSeed` dev only           | deleted                                                       |
| `submissionLog`   | recent first submissions; `person`                                                                                                      | linked | written by `story_limits` only; person live                                  | deleted                                                       |
| `fence`           | counters                                                                                                                                | none   | events only; `PERMISSIONS NONE`                                              | stays (no data)                                               |
| `erasedIdentity`  | sha256 of an erased Clerk id (D82): pseudonymous; no link, no date                                                                      | kept   | api-user creates and reads; nobody updates or deletes                        | kept for ever                                                 |
| `pendingDeletion` | Bunny ids, deleted stories' folders, a Clerk id until deleted (D40); no link                                                            | kept   | erasure and story deletes; api-user and housekeeping retry and delete        | gone once done, a folder after its final pass                 |
| `staffMember`     | staff emails and roles (Staff page); no user link                                                                                       | none   | api-admin only; `@heisreal.today`; never the last Admin (fenced)             | removed on the Staff page; not erased (staff, not story data) |
| `blockedEmail`    | a blocked email (block list); no user link                                                                                              | none   | api-admin only (api-user reads one it names); `addedBy` required             | kept until an Admin removes it (G21 D: permanent)             |
| `blockedIp`       | a blocked IP address (block list); no user link                                                                                         | none   | api-admin only (api-user reads one it names); `addedBy` required             | kept until an Admin removes it (G21 D: permanent)             |
| reference tables  | `submissionSettings`, `themeCategory`, `theme`, `themeCatalog`, the four legal texts, `service`, `_migration*`, `_identity`, `_setting` | none   | —                                                                            | —                                                             |

- **REQ-DB-014** `storyStatusLog.by`, the legal texts' `publishedBy` and the settings' and themes' `changedBy` point at staff `user` rows, which become stubs like anyone's. [D37]
- **REQ-DB-015** `storyStatusLog.staffEmail` holds a staff member's work email as text (like `addedBy` on the Staff page and block list): it goes with the story's entries, not with the staff member. [EM-1]
- **REQ-DB-016** A new table that holds or links person data calls `fn::person::live` on create and update, bumps the fence on delete, and is classified in `person-linked.int-spec.ts` and the table above. [D37]
- **REQ-DB-017** "Live" means `fn::person::live`: the person exists and isn't erased, and the write bumps their fence. [R5]

## Erasure

- **REQ-DB-018** `fn::account::erase` (`schema-02-people.surql`) is the one erasure, run on api-user's own login in one transaction (`ERASE_ACCOUNT`, `libs/database/src/lib/erasure.ts`). [D39]
- **REQ-DB-019** The erasure serves "Delete my account" (`DELETE /v1/account`, the person's withdrawal of consent) and Clerk's `user.deleted` webhook (Svix signature, deduplicated on `svix-id`); both answer `202`. [D39]
- **REQ-DB-020** The erasure takes these steps, in this order: [D39]

1. The tombstone (`erasedIdentity`), even for a Clerk id with no row.
2. `pendingDeletion` rows for the person's video and audio files not yet removed, and the Clerk
   account unless Clerk started it.
3. The user row becomes a stub (`status = 'deleted'`, no Clerk id, no agreements), which deletes
   their hearts. This comes first because api-user may read a story's `submitter` only once its
   owner is erased.
4. Their stories (the cascade takes status logs, search rows and others' hearts; each delete queues
   its picture folder), idempotency keys, `submitterLimits`, `submissionLog` and `storyFile` rows
   (each takes its `mediaJob` rows).

- **REQ-DB-021** After the commit api-user drains the queue (Bunny, picture folders, Clerk last, which ends their sessions); a failure waits with backoff for the nightly housekeeping, and the answer is still `202`. [D40]
- **REQ-DB-022** After erasure only the stub (id, `createdAt`, `status`) and the tombstone remain. [D37]
- **REQ-DB-023** There is no audit log: who changed something last is on that row (`changedBy`, `publishedBy`). [DB2-R3]
- **REQ-DB-024** Each erasure logs internal ids only, which the restore runbook replays; backups age out after `backup_retention_days`. [D40]
- **REQ-DB-025** For the linked tables, a write for an erased person is refused, even from a session opened before; a write overlapping erasure fails at commit, and erasure losing that race is retried. [D39]
- **REQ-DB-026** Bunny and Clerk deletions are ordered by the application, not by the database. [D40]
- **REQ-DB-027** A compromised api-user login can erase anyone (destructive, not a disclosure); this is an accepted risk: the backup restores it and the erasure log keeps erased people erased. [D13]

Tests: `erasure`, `person-linked`, `concurrency`, api-user's `erasure`, `libs/auth`'s `clerk-session`.

## Transactions, conflicts and retries

- **REQ-DB-028** A transaction sees the database as it was when it began, and only write-write conflicts abort, so a check in a permission or event can pass while another transaction commits the opposite. [R5]
- **REQ-DB-029** Every write that depends on or changes a person bumps `fence:person-<id>` (events run elevated, so no session needs rights on `fence`); of two overlapping ones the second to commit fails with a retryable `Transaction conflict`. [R5]
- **REQ-DB-030** There is one fence per person, so unrelated people never conflict; a Clerk id (`fence:identity-…`) and a theme (`fence:theme-…`) have fences the same way. [R5]
- **REQ-DB-031** On a conflict, the whole command is retried (re-read, re-check, re-write) with a small bounded backoff: `retryOnConflict`, `isTransactionConflict` in `libs/database`, 3 attempts, 4 with an `Idempotency-Key`. [R5]
  Why: the retry sees the committed state, so a newer legal version or an erasure now refuses it.
- **REQ-DB-032** Erasure retries until it commits, then erases the write that beat it. [D39]
- **REQ-DB-033** These conflicts are expected: a moderator approving while the person edits, two tabs of one person, a file failing while a moderator approves, two admins saving the themes or the same legal version. [R5]
- **REQ-DB-034** A command handles three outcomes: rules in events throw errors (codes the APIs map), permissions give empty results or dropped fields, and overlaps give a retryable conflict. [D13]
- **REQ-DB-035** A command checks what it wrote with `requireWritten`, which works only on tables the caller can read back. [D13]

## Known gaps

- **REQ-DB-036** A session opened before erasure can still read the person's remaining rows until its token expires; its writes are refused or conflict. [D39]
- **REQ-DB-037** The OWNER login can still remove the guard events; the migrator and the backup (VIEWER, reads everything) are trusted in-cluster system users. [D14]

Not yet tested: reconnects (the harness uses `reconnect: false`; against a restarted SurrealDB,
sessions re-attach, a person session whose token expired meanwhile ends up invalidated and not
running as the service, in-flight requests fail cleanly, and the service connection signs in again);
Clerk's real `user.deleted` delivery on dev; clock skew between Clerk and the cluster (Clerk tokens
live 60 s with `nbf` 5 s in the past).
