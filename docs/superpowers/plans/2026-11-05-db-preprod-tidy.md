# Pre-production database tidy (database review 2, pull request A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the clean-up Joel approved in database review 2 (R1, R3, R4, R5, R7, R8, R10-B, R14, the
super-admin wording in the draft legal texts), and wipe and rebuild dev's database once, through
the normal pipeline.

**Architecture:** Schema-first: the declarative schema is split into area files the runner applies
as one step; every behaviour change is pinned by the real-SurrealDB integration suites. The dev wipe
is a runner step switched on by an OpenTofu parameter that only the dev root sets, recorded in a
bookkeeping table so it runs once per token.

**Tech Stack:** SurrealDB 3.2.4 (patched pin), Python runner (stdlib), NestJS 12, Vitest, OpenTofu.

**Spec:** `project/context/research/db-review-2-decisions.html` (section 3a, clean-up list, rules,
cards R1 R3 R4 R5 R7 R8 R10 R14, section 6 item 11) and the task brief `.review/tasks/pr-a-db-tidy.md`.

## Global Constraints

- Build exactly the approved items; anything else at the data, API or behaviour level is a question for Joel.
- Not in this PR: one story table, storyStatusLog, storyFile, the super-admin view (pull request B).
- `user.status` is `'active' | 'deleted'`, default `active`; no date, no reason.
- `publishedBy` on the four legal-text tables: `record<user>` set by api-admin, readonly; NONE only from a system user (the seed of version 0).
- Fence ids: `fence:person-<user id>`, `fence:identity-<sha256>`, `fence:theme-<theme id>`; one function `fn::fence::touch($key)`.
- Hearts: `favourite:<ulid>`, refused unless `time::from_ulid(record::id(id))` is within 5 s of now; no `createdAt`; `(person, story)` UNIQUE stays.
- Scale and timing checks run on a local SurrealDB only (never GCP or Bunny).
- The dev wipe can only run where both OpenTofu's environment and the database's `_setting:current.environment` say `dev`.

## Review Focus

- A heart created with a hand-made id (not a ULID, or a ULID from the past or future): refused.
- An erased person's still-open session (status `deleted`): every person write still refused, Clerk sign-in refused.
- The wipe parameter set on a non-dev database or with a non-dev environment: the runner refuses before changing anything.
- The wipe run twice with the same token: the second run changes nothing.
- Expired request keys of a person, of Clerk and of an admin: housekeeping deletes all three kinds; unexpired keys stay, and housekeeping can't delete those.

---

### Task 1: Split the schema and teach the runner, Tofu and tests the folder (R10-B)

**Files:** Create `libs/database/schema/schema-01-system.surql` … `schema-06-settings-and-logs.surql` (system, people, themes, stories, legal texts, settings and logs); delete `schema.surql`; modify `migrate.py`, `infra/terraform/modules/db-migration/tests/job_name.tftest.hcl` (+ fixtures), `libs/database/integration/migration.int-spec.ts`, `support/harness.ts` (`SCHEMA_DIR` users), `infra/k8s/surrealdb/scripts/local-migration.mjs`, `docs/db-permissions.md` (the 3.2.4 gotchas move there).

- [ ] Runner: `SCHEMA_FILE = re.compile(r"^schema-\d{2}-[a-z]+(-[a-z]+)*\.surql$")`; the schema step applies every such file in name order (at least one; `schema.surql` alongside is a bundle error); summary counts statements across them.
- [ ] Migration test helpers append scratch DDL to the last schema file; previous-release test keeps the old runner for the old single-file bundle.
- [ ] Run `pnpm nx run database:integration` (migration suite) and `tofu test` for the module: pass.
- [ ] Commit.

### Task 2: R1 leftovers, R7 rights, R8 indexes
- [ ] Delete the 64 `REMOVE …` lines, `tag`, both `tagRefs`, data 0004 and 0008 and their tests (themes 0008 replay, story-shape 0004 check, SEEDS lists).
- [ ] api-admin loses delete on `uploadGrant`, `submissionLog`, `moderationReview` (service-permissions suite asserts the refusal).
- [ ] Drop `pendingDeletion_at`; `publicStory_slughist` becomes `FIELDS slugHistory.*` (local EXPLAIN: plain index = TableScan, element index = IndexScan).
- [ ] Integration suites pass; commit.

### Task 3: R3 audit log out, publishedBy in, user.status
- [ ] Tests first: agreements/legal publish asserts `publishedBy` = the admin and refusal without it from a service; erasure asserts `status = 'deleted'`, stub, no reason; person-session/access asserts a deleted person's session can't write and Clerk sign-in refuses.
- [ ] Schema: drop `auditLog`, `fn::audit::service` and every `CREATE auditLog`; `user.status` with VALUE rules (only `active → deleted`, never back, set by erasure); every `gdprDeletedAt` check → `status = 'deleted'`/`!= 'deleted'` (schema, access-clerk.surql, 0009); `publishedBy` + `fn::legal::check_version` refusal when NONE and `$auth != NONE`.
- [ ] api-admin legal publish writes `publishedBy: $user`, no audit row; themes/settings controllers comments; `erasure.ts` comment; my-data drops the audit-log sentence; OpenAPI `UserAdmin.status`; dev-seed stops wiping `auditLog`.
- [ ] Suites pass; commit.

### Task 4: R5 one fence table
- [ ] `fence` table + `fn::fence::touch($key: string)`; `fn::fence::bump` → `touch('person-' + id)`; identity and theme callers likewise; theme delete removes `fence:theme-<id>`.
- [ ] concurrency/person-linked/themes suites (existing race tests are the proof) pass; commit.

### Task 5: R4 expired request keys
- [ ] Test (housekeeping integration): expired keys of all three owners deleted, live ones kept; housekeeping's own `DELETE idempotencyKey` of a live key deletes nothing.
- [ ] Schema: idempotencyKey `FOR select, delete` adds `$auth.id = service:housekeeping AND expiresAt < time::now()`; housekeeping chore `expired-request-keys`; fix `idempotency.ts` comment.
- [ ] Pass; commit.

### Task 6: R14 hearts' ids carry the time
- [ ] Tests (libs/database favourites): non-ULID id, back-dated ULID and future ULID refused; normal heart ok. api-user favourites/export suites: order and paging by id, `heartedAt` from the id.
- [ ] Schema: drop `createdAt`, `favourite_list`; event check; api-user creates `favourite:ulid()`… actually `type::record('favourite', rand::ulid())`; list orders `id DESC`, cursor `{v:2,k:[id]}`; export reads `time::from_ulid`.
- [ ] Pass; commit.

### Task 7: Legal wording, dev wipe, docs
- [ ] 0009: "While it's a draft: you, and a small number of super admins (for support and safety). While it's waiting for review: our moderators." in testimony consent and the privacy notice's passage; fixtures/e2e quoting it.
- [ ] Runner reset step: param `dev_database_reset` (string or null). If set and not yet in `_migrationReset`: refuse unless param environment and stored environment are both `dev`; remove every table except `service`, `_identity`, `_migrationRun`, `_migrationPending`, `_migrationReset`, and every function; record the token. Integration test: wipes, runs once, refuses outside dev.
- [ ] Tofu: `db-migration` variable `dev_database_reset` with a precondition environment == "dev"; cluster module passes it; `live/dev/cluster` sets the token.
- [ ] Docs: delivery-status, how-the-app-works, db-permissions, AGENTS/README lines.
- [ ] `pnpm nx affected -t lint typecheck test build` + integration suites; commit, push, PR.
