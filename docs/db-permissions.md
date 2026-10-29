# Database permissions: D13 + D27 spike

Spike for D24 step 3 (`project/context/research/m0-schema-consent-decisions.html`, D13 B and
D27 B). It proves the draft `schema.surql` permission model on **SurrealDB v3.2.4** (the
digest the cluster runs) with **surrealdb.js 2.0.8** (the version in the lockfile), using
automated tests. It also records what had to change in the draft and what is still unproven.

## Where it lives and how to run it

| Path                                          | What                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `libs/database/schema/schema.surql`           | Declarative schema (D14), applied in full in one transaction                   |
| `libs/database/schema/access-clerk.surql`     | `DEFINE ACCESS clerk`, only when `$clerk_jwt_public_key` is set                |
| `libs/database/schema/data/000N-*.surql`      | Run-once: 0001 draft DPA v1; 0002 dropped (D44); 0003 dev story (retired, D49) |
| `libs/database/schema/migrate.py`             | The D14 runner: the migrate Job and these tests both use it                    |
| `libs/database/integration/*.int-spec.ts`     | 514 integration tests against a real SurrealDB                                 |
| `libs/database/vitest.integration.config.mts` | Their Vitest config, kept apart from the unit tests                            |

```bash
pnpm nx run database:test-integration    # needs Docker; about 20 s
```

- **Why `libs/database/schema` and not `infra/db`** (the doc's D14 layout): files under an Nx
  project make it "affected", so any schema change runs `test-integration` in CI. Next to the
  client code, the schema and the code that queries it change in the same PR. The migration
  Job (D14) can still read these files from OpenTofu by relative path.
- **The container.** Vitest's global setup runs `docker run` with the image read from
  `infra/k8s/surrealdb/base/kustomization.yaml` (tag + digest). The tests therefore always use
  the version the cluster runs, and there's one pin to bump. The root password is random per
  run. Set `SURREAL_TEST_URL` / `SURREAL_TEST_USER` / `SURREAL_TEST_PASS` to use a running
  server instead.
- **Isolation.** Each spec file gets its own namespace, so the files run in parallel.
- **Setup.** An OWNER `migrator` applies the bundle with the D14 Job's own runner
  (`migrate.py`), from the same files. Each service gets a `service` record with a random
  password, argon2-hashed by `crypto::argon2::generate` (in the cluster SurrealDB's startup init does this;
  `migration.int-spec.ts` runs the real init template). Clerk is simulated by an RS256 key pair
  generated per run; the public PEM is passed as `clerk_jwt_public_key`, as OpenTofu passes
  Clerk's.
- **Kept out of `test`.** `nx affected -t test` still runs without Docker; CI has a separate
  `nx affected -t test-integration` step. CI uses no `services:` container because it can't
  pass SurrealDB its `start` arguments. No new dependencies.

## What was proven

Every **denied write** asserts the empty result **and** checks through the migrator (which
bypasses permissions) that the row is unchanged or absent.

| Claim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Spec                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Schema (draft 122 statements, now 147) applies and re-applies cleanly; seeds run once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `schema`                          |
| Only the migrator (OWNER) can `DEFINE`/`REMOVE` anything. Every service and person session is refused `DEFINE TABLE/FIELD/ACCESS/USER/FUNCTION`, `REMOVE EVENT`, `REMOVE TABLE`. The guard events are still present afterwards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `schema`                          |
| `svc` sign-in: argon2 hashes only. Wrong password, another service's password and unknown names are rejected. No service can read, rewrite or create `service` rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `service-permissions`             |
| `api_public_read`: only `publicStory`, `tag`, published `dpaVersion` and `_setting` (D48, readable by everyone). Nothing in `story` (not even approved rows), `consent`, `user`, reviews, audit, idempotency keys or `_migration`. Every write is a no-op.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `service-permissions`             |
| `api_user` login: can't read, create, edit or reassign stories, or read or forge consent. It can delete stories (erasure), create/update users but not rebind or clear `clerkUserId` outside erasure, write but not read audit rows, own idempotency keys, and can't moderate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `service-permissions`             |
| `api_admin`: reads all stories, consent, reviews and audit; can't write consent; manages DPAs (published = frozen, none deletable); links a legacy person's Clerk ID once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `service-permissions`             |
| D41 write scope: `workflow` writes media/processing fields only; content, status, approval, lock and feedback writes are dropped. `api_admin` writes moderation fields and status only; content and media writes (including `media[0].x`) are dropped, and `publicStory` must mirror the approved story.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `write-scope`                     |
| Consent is append-only for every identity: permissions give an empty result; even the OWNER migrator is stopped by the event.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `service-permissions`, `consent`  |
| Clerk JWT (D27): `sub` maps to `user` by `clerkUserId`. Rejected: expired, wrong key, `ac` = `svc` or unknown, unknown `sub`, other database, no `exp`, HS256-with-public-key confusion, tampered payload, erased person. An `id` claim can't override `AUTHENTICATE`; `iss`/`azp` aren't checked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `person-session`                  |
| A person sees only their own stories (drafts and pending too), never anyone else's in the write model, approved included. They see only their own consent and user row, and only published DPAs. `fn::consent::current(otherUser)` returns nothing to them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `person-session`                  |
| Draft creation: only for themselves, only as `draft`, only with current Art 9 consent. Moderation fields can't be pre-filled; `version`/`createdAt`/`submittedAt` are server-set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `person-session`                  |
| Editing: own drafts only; `submitter` can't be reassigned; moderation fields are silently dropped; only submit or withdraw is allowed; no backdated `submittedAt`. Content is locked after submit, editable again after `changes_requested`. They can't delete stories, can withdraw (and unpublish) their own, and can't touch others'.                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `person-session`                  |
| Consent at every step: edit/media needs current Art 9; submit and approval need Art 9 + `publish` + `age_18plus`; the read model needs them too. Withdrawing a story needs none. Includes Codex's reproduction (withdraw Art 9, then edit, submit, approve: all refused, nothing published).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `consent-gates`                   |
| D17 derivation over many people and stories: grant, re-grant to a newer DPA, withdraw and re-consent each change every one of that person's stories at once, and nobody else's. Correct in multi-row selects, in subqueries and in the person's own view.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `consent`                         |
| D20/D22: no consent against a draft DPA (accepted once published). `occurredAt` is server time. Legacy consent (mechanism, legacy DPA, `legacyGivenAt`) is migrator-only. The 0003 import pattern derives `legacy-squarespace`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `consent`                         |
| Both 3.2.4 bugs are pinned (they fail when an upgrade fixes them).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `consent`                         |
| Erasure on `api_user`'s login removes stories, read-model rows, reviews and idempotency keys, clears `clerkUserId` and leaves a stub `user` row, the consent ledger (pointing at the stub) and id-only audit rows. Fresh sign-in fails; nobody can rebind or un-erase the stub. A session opened before erasure can't write; an overlapping transaction fails at commit (see `concurrency`). Works after consent withdrawal.                                                                                                                                                                                                                                                                                                                                                               | `erasure`                         |
| D38: audit rows have typed, enum-checked fields; a payload or any unknown field is refused, as are free-text actions, reasons, statuses, roles and consent types.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `erasure`                         |
| Concurrency (round 2): a story create overlapping erasure, an approval overlapping a publish withdrawal, a submit overlapping an Art 9 withdrawal, and a workflow media write overlapping erasure all lose at commit with a retryable conflict, with stored state clean. Erasure losing to a create is retried and then erases it. Unrelated people never conflict. No session can read or write a fence.                                                                                                                                                                                                                                                                                                                                                                                  | `concurrency`                     |
| Service writes check the **submitter's** consent: workflow media/processing writes (draft and approved) are refused once Art 9 is withdrawn, stored state unchanged. Moderation without content change, withdrawal and deletion stay consent-free.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `consent-gates`                   |
| D38 retention: only the migrator, and only for subjects erased more than 6 years ago (2192 days), can delete consent; live, recently erased and 2191-day-old subjects are refused, and so is every service and person. Audit rows: the migrator can prune; no service or person can.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `retention`                       |
| Round 3 sweep: every table is classified (a new, unclassified table fails the test). For each person-linked table (`story`, `publicStory`, `hiddenStory`, `consent`, `moderationReview`, `idempotencyKey`), a control write works, the same write is refused after erasure from a session opened before it, and a write racing erasure loses at commit with nothing stored. Root (`user`): two racing erasures, one wins, the retry is a no-op. Kept (`auditLog`): a racing audit write commits with typed fields only.                                                                                                                                                                                                                                                                    | `person-linked`                   |
| Round 3, P2: a service-supplied `gdprDeletedAt` (2200 days ago) is replaced by the server time and can't be re-dated, so the nightly prune keeps the consent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `retention`                       |
| D53 story types: `written` needs non-blank text and no video or audio; `video`/`audio` hold at most one media item of their own format, exactly one from submit on (a draft is created before its upload), and no image; images only on written stories. Pixel sizes are positive ints, both or neither, refused beyond 1:3 or 3:1; an audio file's are its thumbnail's (Joel, 2026-10-24); undefined media or image fields (the old `aspectRatio`, free text) are refused. The image is the person's content: `api_admin`/`workflow` writes are dropped, it's locked after submit and needs Art 9 to change. `publicStory` mirrors the image and media sizes and refuses extra fields. Same rules for the migrator. Data script 0004 fails the migration for earlier rows that don't fit. | `story-shape`                     |
| A2 processing gate (Joel, 2026-10-23): `media[*].processing` and `image.processing` are set only by `workflow` and system users. A person's value is ignored on create and update, `api_admin`'s is dropped, and workflow can't change the image's other fields. Any change to a media item or the image by the person sets it back to not processed. Approval (by anyone, the migrator too) is refused unless every item is `ready`, a video has width, height and duration, an audio file its duration and its thumbnail with that picture's width and height, and the image is `ready`; `publicStory` refuses to publish or re-sync otherwise. A3/POC text limits: `body` at most 10,000 characters; a written story needs 200 trimmed characters from submit on.                       | `media-processing`, `story-shape` |
| D48 dev-only relaxed consent: off by default, and every session reads it as off; a bound variable can't switch it on; no service or person can write `_setting`. On (dev): a person without consent rows can create, submit and be published, and `fn::consent::granted` (the guard's question) says yes, while the ledger and `fn::consent::current` stay untouched and the ledger's own rules (published DPA) still hold. Any other or unknown environment fails the migration, and the database refuses the row even from the migrator.                                                                                                                                                                                                                                                 | `dev-consent`                     |
| D14 + cutover: restart with a one-transaction startup init ends old sessions; a failed init keeps old identities and the identity check stays not Ready. RETURN can't reach a data script; a missed one fails loud and blocks (exit 3). Database fencing token: later runs win. Checks run before changes; seeded DPAs keep their files.                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `migration`                       |
| A person creates and reads only their own `api-user` idempotency keys (round 1 of #41): none for another person, service or webhook, no reading others', no update or delete, none after erasure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `person-session`                  |
| One connection, one session per request, concurrent people isolated; dangers pinned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `request-sessions`                |

## Changes to the draft schema (port back to the decision doc)

`git diff aa7d671 -- libs/database/schema/` shows exactly these. The seeds are unchanged.

1. **Bug: `story.consent` used `$parent.submitter`.** On 3.2.4, when a story is read **inside a
   subquery**, a COMPUTED field's `$parent` is the outer query's record. So
   `SELECT (SELECT consent FROM story WHERE …) FROM user` derived `NONE` for every story. That
   fails closed, but it's wrong. **Fix:** use the record's own field:
   `fn::consent::current(submitter, …)`. It's correct both at the top level and in subqueries.
2. **Gap: drafts could be created without Art 9 consent.** The create permission now requires
   current Art 9 consent (`fn::consent::granted(submitter, ['special_category_religious'])`).
   Review round 1 extended this to every step (item 5).
3. **Gap: erasure couldn't reach the read model or reviews.** `api_user`'s login may delete
   stories but not read them. Both `DELETE publicStory WHERE type::record('story',
record::id(id)).submitter = $u` and `DELETE moderationReview WHERE story.submitter = $u`
   silently match nothing, which would leave **published Art 9 text in `publicStory`**. **Fix:**
   a new `story_erasure_cascade` event. Deleting a story deletes `publicStory:<same id>` and its
   `moderationReview` rows in the same transaction, whoever deletes it.
4. **Header comments corrected and extended:**
   - The `$parent` rule is restated. Chaining computed fields **through record links** worked
     in every test; the trigger is a subquery.
   - Two new gotchas: allowed-but-unreadable writes, and `$auth.id` for services (both below).

### Review round 1 (Codex) and D37/D38/D41

5. **Consent stopped at draft creation (finding 1).** A person could withdraw Art 9 consent and
   still edit and submit, and api-admin could then approve and publish. The consent types per
   command come from the decision doc's API plan (⚑ routes) and `libs/contracts`
   (`x-requires-consent`, #28):
   - **create draft, edit, upload-url:** "Needs the person's current Art 9 consent", i.e.
     `[special_category_religious]`;
   - **submit:** "⚑ the person's current Art 9 + publish + age consent (D17)", i.e.
     `[special_category_religious, publish, age_18plus]`;
   - **approve:** "⚑ fresh ledger check" for the submitter, same three types.

   **Fix:** a new `fn::consent::granted(user, types)`, plus:
   - `story_owner_consent`: an owner's content or media change needs Art 9, and → `pending`
     needs all three;
   - `story_approval_consent`: → `approved` needs the submitter's three, whoever does it;
   - `publicStory_mirrors_story`: every `publicStory` write needs the submitter's three.

   Withdrawing (→ `withdrawn`, no content change) and erasure (`DELETE`) need none. These are
   events, so a refusal is an **error**; the create check stays in the permission, so it's an
   empty result.

6. **An open session could write after erasure (finding 2).** Every person write now also
   requires `$auth.gdprDeletedAt = NONE`: story create and update, consent create, and
   `publicStory` delete. `$auth` is a record id, so this reads the user row as of the
   transaction's snapshot, not as of sign-in; the regression test opens Bob's session before
   erasure. **Correction from round 2:** this alone doesn't cover a transaction that is already
   open when erasure commits. Item 10's fence does.
7. **D41 write scope (finding 3).** Field-level `PERMISSIONS FOR update` on `story`:
   - content (`slug title description body bylineName primaryFormat tagRefs`): not `api_admin`,
     not `workflow`;
   - `status`: not `workflow`;
   - `media` and every `media[*].x`: not `api_admin`;
   - moderation fields (`lockedBy lockedAt rejectionFeedback approvedAt`): `api_admin` only
     (no longer `workflow`).

   Out-of-scope writes are **silently dropped**. `publicStory_mirrors_story` also stops api-admin
   publishing text the person didn't write: the read model must equal the approved story's
   content and playback media.

8. **D37 erased user record.** `user_clerk_binding` now allows exactly two changes:
   - linking `NONE` → id, for a never-erased user, by anyone but api_user;
   - clearing id → `NONE`, by api_user only, in the same update that sets `gdprDeletedAt`.

   A new `user_erasure_final` event makes `gdprDeletedAt` permanent and forbids a Clerk id on an
   erased user. The field permission now lets api_user update `clerkUserId`, so that it can
   clear it.

9. **D38 audit.** `auditLog.payload` (`object FLEXIBLE`) is replaced by typed optional fields:
   `storyVersion`, `fromStatus`/`toStatus`, `consentType`, `dpaVersion` and `role`, plus `reason`,
   an enum of the three D39 erasure callers. `action` and `actorRole` are enums too. The
   `action` list is the API plan's commands plus `LinkLegacyUser` and workflow's `ProcessMedia`
   (and, since item 27, the database's own `HideStory` and `RepublishStory`).
   SCHEMAFULL **rejects** unknown fields (an error, not a silent drop), so a payload can't be
   smuggled in.

### Review round 2 (Codex)

10. **Transactions could commit after erasure or consent withdrawal (P1-A).** SurrealDB checks
    permissions, consent and `gdprDeletedAt` against the transaction's **snapshot**. Codex
    reproduced two cases on 3.2.4 + RocksDB, and they reproduce on the in-memory engine too:
    - a draft created in an open transaction committed after erasure;
    - an approval committed after the person withdrew publish consent.

    **Fix: a per-person write fence.**
    - A new `personFence` table is `PERMISSIONS NONE`; its id is `personFence:<user id>` and it
      holds a counter, nothing else.
    - `fn::fence::bump(user)` upserts it.
    - Events call it on every `story` create/update/delete (submitter), every `publicStory`
      write (the story's submitter), every `consent` write (subject) and every `user`
      create/update (erasure, binding).
    - So any two transactions that depend on or change the same person write the same key, and
      the **second to commit fails**: `Transaction conflict: … This transaction can be
retried`, on both RocksDB and the in-memory engine.

    **Why a separate table.** Events run with **elevated privileges** on 3.2.4: a person's story
    event wrote a row into a `PERMISSIONS NONE` table. So no session can touch the fence directly
    (tested for every service and a person) and no permissions widened. A counter on `user`
    would have needed person-writable `user` rows.

    **Why not something else.** There's no `SELECT … FOR UPDATE` and no read-set conflict
    detection: only write-write conflicts abort. So the overlapping transactions have to write a
    common key. One key per person keeps unrelated people from conflicting (tested).

    The test container now runs **RocksDB** (`rocksdb:/tmp/surrealdb`), the production engine.

11. **Workflow media writes skipped consent (P1-B).** The consent event only checked owner
    writes. It's now `story_consent` (it replaces `story_owner_consent`): **any** content or media
    change, by the person, workflow or api-admin, needs the **submitter's** current Art 9
    consent. The submit check stays owner-only (only the owner submits).
    - **Other service paths checked:** api-admin approval (already any caller), `publicStory`
      writes (already any caller), workflow media (fixed).
    - **Still consent-free by design:** api-admin moderation without content changes (lock,
      feedback, reject, request changes), withdrawal and deletion.
12. **Consent pruning was impossible (P3).** `consent_append_only` refused every delete, the
    migrator's included. It now refuses all updates, and any delete except by a system user
    (no record `$auth`; only the migrator, since backup is VIEWER) of a subject erased more than
    `2192d` ago (6 × 365 + 2 leap days, so never early). The nightly job is one statement:
    `DELETE consent WHERE subject.gdprDeletedAt != NONE AND subject.gdprDeletedAt < time::now() - 2192d`.

    `auditLog` didn't have this problem: deletes are `PERMISSIONS NONE` for every session and no
    event blocks the migrator. The age limit for audit rows lives in the job, not the schema
    (their `createdAt` is server-set). Fence rows of erased people (a counter) can go with the
    stub.

### Review round 3 (Codex)

13. **Moderation reviews survived erasure (P1).** A review created in a transaction that raced
    erasure committed, and a review could be created for an already-deleted story. Rather than
    patch one table, every table is now classified (next section). The new
    `fn::person::live(user)` refuses a write linked to a missing or erased person and bumps that
    person's fence. It's applied on create/update of every **linked** table:
    - `story`: `submitter`;
    - `publicStory`: the story's submitter;
    - `consent`: `subject`;
    - `moderationReview` (new event `review_live_story`): its story must exist, and the story's
      submitter must be live;
    - `idempotencyKey`: see item 14.

    Deletes on every linked table only bump the fence, with no live check, so erasure,
    withdrawal and pruning still work. `moderationReview` and `idempotencyKey` deletes bump it
    too (round 4). In the erasure cascade the story is already gone, so a review's bump is a
    no-op there; the story delete and the `user` update already bump.

14. **`idempotencyKey` carried the Clerk id.** Its id was `[service, clerkUserId, key]`: erasure
    clears the Clerk id from `user`, but the key would keep it, and a key written while erasure
    ran would survive.
    - **Fix:** keys are scoped by the **user record** (`['api-user', user:x, key]`) or a webhook
      provider (`'svix'`, `'stripe'`), and anything else is refused. A person-scoped key needs a
      live user and bumps the fence. Erasure deletes `WHERE record::id(id)[1] = $u`.
    - `response` is now typed (`{ id, version }`, no free fields).
    - **Assumption for M3:** moderators and admins have a `user` row. They already need one for
      `moderationReview.moderator` and `auditLog.actor`.
15. **A service could backdate erasure (P2).** `gdprDeletedAt` was a plain field, so `api_user`
    could set it 2200 days back and the nightly prune deleted the consent at once. Its `VALUE` is
    now:
    - `$before` once set, so it's immutable; un-erasing or re-dating is ignored;
    - otherwise the **server time** for any record session;
    - a supplied date only for a system user (`$auth = NONE`, i.e. the migrator).

    D22's legacy import doesn't need a historical erasure date: legacy people aren't erased. This
    also corrects the draft's header gotcha: **`$auth` is usable in a field `VALUE` on 3.2.4**
    (tested).

### Review round 4 (Codex: approve with nits)

16. **D37 on CREATE/INSERT.** `user_erasure_final` only checked UPDATE, so a service could
    `CREATE`/`INSERT` a user that was already erased but still carried a Clerk id. The
    Clerk-free rule now applies on create too: an error for `api_user` and the migrator, while
    `api_admin` can't create users at all.
17. **Delete fencing made true everywhere.** Deleting a `moderationReview` or a person-scoped
    `idempotencyKey` now bumps the fence, like the other linked tables. Tested by checking the
    counter.
18. **api_admin first stamp tested.** api_admin erasing a Clerk-free legacy user stores the server
    time, not the supplied date.

### PR #41 review round 1 (idempotency keys in the person's transaction)

19. **An `Idempotency-Key` saved after the command could be lost (P1).** api-user saved the key on
    its service login after the person's command had committed. A failure in between left the
    consent grant without its key, so retrying the original request after a withdrawal granted
    again; two concurrent requests with one key both applied. **Fix:** a person session may now
    `create` and `select` `idempotencyKey` rows whose id is `['api-user', $auth, …]` (and, for
    create, only while not erased), so the command, the key, the request hash and the stored
    response commit in one transaction (`runIdempotent` in `libs/database`). A second request
    with the same key fails on the existing record, re-reads it and replays. Every retry (a
    conflict or a lost key race) goes back through the key lookup before re-preparing the command
    (round 2), so it replays even if the command would now be refused (e.g. a newer DPA in force). No `update` or
    `delete` for people: erasure and pruning run on the services' logins. Tested in
    `person-session` (own keys only; no forging for another person, service or webhook; no
    reading others'; no update/delete; refused after erasure) and in `libs/consent`'s
    `idempotency` spec (fault injection, concurrent same-key requests, different-body reuse).

### M1 step 3 (D53 story types and shapes, D48 dev-only relaxed consent)

20. **D53: three story types, enforced by the database.** `fn::story::shape_problem($s)` is the
    one definition (event `story_shape` on every create and update, by anyone; data script 0004
    for rows written before it): written = non-blank `body`, no media, optional `image`;
    video/audio = at most one media item of that format, exactly one in `pending`, `in_review`
    and `approved` (CreateDraftStory creates the draft before the upload, and a draft can be
    withdrawn before it), optional `body`, no `image`.
21. **D53: real pixel sizes.** `media[*].width`/`height` replace `aspectRatio` (`REMOVE FIELD`);
    `image {path, width, height, alt}` is new. Positive ints, both or neither, never beyond 1:3 or
    3:1 (`fn::shape::allowed`); audio has none. **3.2.4 stores undefined keys in `array<object>`
    items, and `REMOVE FIELD` keeps stored values** (both tested), so the shape check allows only
    the defined media fields, and 0004 fails the migration while earlier rows still carry
    `aspectRatio` (it rewrites nothing: media is the person's content, and changing it needs
    their consent). Cards clamp the shape between 9:16 and 2:1 (`apps/web/src/lib/shape.ts`).
22. **D53 + D41: the image is the person's content.** `image` and each `image.*` field have the
    content fields' write scope (not `api_admin`, not `workflow`), and `fn::story::content`
    includes it, so the content lock after submit and the Art 9 gate on changes cover it.
    `publicStory` gets the same fields; `publicStory_mirrors_story` compares the image and the
    media sizes, and refuses media fields other than the playback ones. Images are personal data:
    erasure deletes the row with the story (the file itself: D40's Bunny deletions, not built yet).
23. **D48: one switch, in a row.** `_setting:consent {devConsentRelaxed, environment}` is written
    by the runner in the schema step from OpenTofu's `dev_consent_relaxed` and the environment
    (from the GCP project). `fn::consent::relaxed()` reads it; `fn::consent::granted` returns true
    for any person when it's on, so the story permission, the consent events, the read-model
    mirror and libs/consent's guard all follow it. `_setting` is `select FULL`, every write
    `NONE` (system users only), and event `_setting_dev_only` refuses `true` unless
    `environment = 'dev'`. **Not a `DEFINE PARAM`: inside a function a caller's bound variable
    shadows a defined param** (3.2.4, tested), so a person could have passed their own.

### A2 and A3 (Joel, 2026-10-23): approval waits for processing; story text limits

24. **A2: only processing writes `processing`.** `media[*].processing` and `image.processing`
    (NONE = not processed yet, then `processing`, `ready` or `failed`) belong to workflow (M7).
    Field PERMISSIONS alone can't do this: a denied nested field keeps its old value, so a person
    who replaced a processed video would keep `ready`. Instead the VALUE of `media` and of `image`
    decides it on every write. For the person, an item keeps its stored `processing` only while
    everything else in it is unchanged; a new or changed item starts again at NONE, and the
    person's own `processing` is ignored. For workflow, `media` is written as given, and `image`
    keeps the person's fields and takes only workflow's `processing` (so `image` now allows
    workflow writes; `image.path/width/height/alt` still don't). System users write both as given.
    `api_admin`'s writes are dropped, as before. **3.2.4: a field VALUE runs for a nested `SET`
    too, with `$value` the whole new field and `$before` the old one** (tested).
25. **A2: approval waits for processing.** `fn::story::approval_problem($s)` is the one
    definition: every media item `ready`; a video with width, height and a positive duration; an
    audio file with a positive duration and its thumbnail with that picture's width and height
    (Joel, 2026-10-24); an image `ready` (it already has its size). Event
    `story_approval_media` refuses `status → approved` otherwise, whoever writes it, and
    `publicStory_mirrors_story` refuses any publish or re-sync too, so unprocessed (possibly
    malicious) media never reaches the public view. Messages start with `media_not_ready:`;
    `isMediaNotReadyError` in `libs/database` lets api-admin's ApproveStory (M3) answer `409`
    `code: media_not_ready`. `processing` isn't mirrored: a published item is always `ready`.
    ApproveStory must copy the image's `path`, `width`, `height` and `alt` only
    (`integration/support/world.ts` `approve()`). Rows approved before this aren't re-checked
    (no data script): dev's only story is 0003's written story without media or image. If a later
    check marks an approved item `failed`, item 27 hides the story until it's ready again.
26. **A3 and the POC's minimum: text limits.** `story.body` is at most 10,000 characters (was
    20,000; the POC's limit). A written story needs at least 200 characters of trimmed text from
    submit on (`pending`, `in_review`, `approved`) in `fn::story::shape_problem`, so a short draft
    can still be saved. Video and audio text has no minimum. Both this and "needs its text" use
    one whitespace policy, `fn::text::trimmed_length` (mirrored by `trimmedTextLength` in
    `libs/database`). **3.2.4's `string::trim` keeps U+FEFF**, which JavaScript's `trim()` (the
    web) strips, so 199 characters and a U+FEFF passed (Codex, #58). U+FEFF now counts as a space;
    `string::trim` already strips every other Unicode space (and U+0085, which JavaScript keeps). `isStoryTextTooShortError` lets
    api-user's SubmitStory (M2) answer `400` `code: story_text_too_short`. Dev's 0003 story has
    222 characters, so no data script is needed.

27. **An approved story is hidden, not reverted, while its media isn't ready (Joel,
    2026-10-23).** Event `story_media_availability` runs on every update of an approved story.
    If the story stays `approved`, has a `publicStory` row, and `fn::story::approval_problem`
    finds a problem (an item `failed` or back to `processing`, a size or duration removed), the
    same write deletes the row and creates `hiddenStory:<same id>`: `since`, the row's
    `publishedAt` and `slugHistory`, and `identity`, a hash of the **deleted row's** media
    (formats, Bunny ids, image path) and its `thumbnails` (D60 below). When the problem is gone
    and the story's media is still what was reviewed (`fn::story::shows_reviewed_media`), the same write re-creates the row from the story (`publicStory_mirrors_story`
    checks it as on approval) and deletes `hiddenStory`. The status never changes; no new
    approval is needed. **The identity comes from the public row, not the story** (security
    review): workflow can write media, so it could swap the video in the failing write; the swap
    then never matches. Different media stays hidden for a moderator. Any publication (ApproveStory, a moderator's re-publish, the restore) deletes the marker (event `publicStory_clears_hide`), and a marker never stops a hide while a public row exists: the hide replaces it with what is public now (Codex, #61: a stale marker for replaced media let failed media stay public). A story that wasn't public
    (consent withdrawn, D17) is never hidden, so a media fix never publishes it. Withdrawn consent
    at restore time keeps it off too, and withdrawing `publish` or Art 9 consent deletes the person's `hiddenStory` rows (event `consent_withdrawal_unhides`), so giving consent again doesn't publish them either. Leaving `approved` deletes `hiddenStory`, and so does
    erasure (`story_erasure_cascade`). `auditLog` gets `HideStory` / `RepublishStory` (no actor;
    reason `media_unavailable` / `media_restored`).
    **`hiddenStory` is a table, not a story field (Codex, #61):** an event that writes its own
    story bumps `version` again after the command returned, so the caller got a stale version
    (hiding at 4 returned 5 but committed 6), breaking D29. The event never writes the story, so
    the command's own write is its only version step and returns the committed version; the
    re-created row mirrors it. `hiddenStory` is `select` for api_admin and workflow only and
    `create, update, delete NONE`: only the event (events run elevated) and system users write
    it; it's fenced like `publicStory`. Only workflow and system users can trigger it: the
    person's content is locked after submission and api-admin can't write media.
    `fn::story::hidden_by_media()` lists hidden approved stories for api-admin (it runs with the
    caller's permissions). Runbook: [media-runbook.md](media-runbook.md).
    **D60 (Joel, 2026-10-23): a frame Bunny generated for the same video is still reviewed
    media.** Re-encoding a video on Bunny can change its thumbnail. A thumbnail counts as
    unchanged if it is the reviewed one, or one of Bunny's generated frames of that video:
    `<videoId>/thumbnail_1.jpg` to `thumbnail_5.jpg` (`fn::media::generated_thumbnail`). Then
    the story comes back on its own and the row shows the new thumbnail. **Any other thumbnail is
    changed media** (Codex, #67): Bunny stores custom thumbnail uploads in the same video folder,
    so the folder alone proves nothing, and `thumbnail.jpg` (the selected thumbnail) may hold a
    custom image. A different `bunnyVideoId` or image `path` is changed media too. Changed media
    on a public story hides it in the same write (`auditLog` reason `media_changed`; D59: it
    needs approving again), and a hidden story stays hidden. api-public-read still signs a
    thumbnail only as a file directly in its own video's folder (step 5). Not covered: Bunny
    replacing a file's contents under the same name; workflow must never upload custom
    thumbnails. `hiddenStory` rows written before D60 have no `thumbnails` and stay
    `mediaChanged`; in dev, reset the data.

### M1 step 4 (D49 dev-seed login)

- **`dev_seed`, a dev-only system user (EDITOR).** The dev-seed Job (`apps/dev-seed`) writes every
  content table, so it signs in as a system user rather than a `service` record: no table
  permission had to widen, and every event still runs (types and shapes, text limits, the
  approval gate, the read-model mirror; `apps/dev-seed/integration` loads the dataset through
  them). SurrealDB's startup init creates it only with OpenTofu's `dev_seed_login` (refused
  outside dev) and removes it otherwise; the identity check and the migrate Job expect it then.
  An EDITOR could `REMOVE EVENT`, the reason D13 removed the per-service system users; accepted
  here because it exists only in dev, which holds only dummy data, and every migration re-applies
  the full schema. The reset itself refuses unless `_setting:consent` says dev and consent forms
  are published there (dev's placeholders, D75; until the consent forms it required D48's relaxed
  consent), and it gives the fixture people real ledger consent (item 31).
- **0003 retired.** Dev no longer sets `seed_dev_story`; the reset deletes 0003's story.

### M1 step 6a (browse read API)

- **`publicStory.durationSeconds`, computed.** Cards show a clip's length. The field's `VALUE`
  reads the story's `media[0].durationSeconds` on every write, so no publisher copies it and none
  can set it (`write-scope.int-spec.ts`). The approval gate (A2) means a published clip always has
  it. Rows written before the migration get it on their next write; in dev, reset the data.
- **`story_published_media_facts`.** When processing corrects an approved clip's size or duration,
  or a re-encode gives it another frame Bunny generated (D60), while it stays ready, the same
  write copies them into the published row. Only while the story's media is still what was
  reviewed (`fn::story::shows_reviewed_media` against the row). Anything else (another clip or
  image, a custom thumbnail) is never copied: #61's event hides the story in the same write.
  Copying it would make unreviewed media look reviewed.
- **`publicStory.tagSlugs` (D63), computed.** `GET /v1/tags` lists a tag only if a published
  story uses it: one probe per tag, at most one match, through the element index
  `publicStory_tag_slugs` (`tagSlugs.*`), never a scan of every story. Each probe is a top-level
  statement with its slug bound (`$t0`, `$t1`, ...): inside a closure 3.2.4 iterates the whole
  table instead (Codex, #67; at 10,000 rows 313 ms against 20 ms for 30 tags). The slugs are computed
  from `tagRefs` on every write, so no writer sets them. Not an index over `tagRefs` itself:
  on 3.2.4 an element index over record links makes `CONTAINS` return no rows (a gotcha test in
  `schema.int-spec.ts`). Rows written before the migration get it on their next write; in dev,
  reset the data.
- No permission changed: api-public-read still reads only `publicStory` and `tag`.

### M2 consent forms (D73, D75, D77, D84, D85, D86, D93)

28. **Three versioned form tables (D84, D93).** `signupFormVersion` (D73: 18+, asked here only,
    and `account_data`, "store my account and favourites"), `testimonyFormVersion` (D67: Art 9 at
    the start of a draft; `publish` at submit when the version covers it) and the optional
    `socialSharingFormVersion` (`share_socials`: sharing beyond heisreal.today), id = the
    version (`v1`). All three: `status` draft/published/retired, `textRef` + `textHash` + `text`
    (the words of `libs/legal/forms/<form>/<id>.md`, kept in step by `form-sync.surql` like
    `dpa-sync.surql`), `dpaVersion`, `publishedAt` (server time). Testimony adds
    `requiresAcceptanceForNewSubmissions`, `coversPublicPublishing` and `draftRetentionMonths`.
    Social sharing adds one boolean per platform (`shareYouTube`, `shareInstagram`,
    `shareTikTok`, `shareFacebook`) and per use (`allowEditingAndClipping`,
    `allowChurchAndPartnerMedia`, `allowPrintAndEvents`, `allowPaidPromotion`), all
    `DEFAULT ALWAYS false`: a column added later reads NONE, "no", on older versions, and retiring
    one still works (a plain `DEFAULT` makes the update fail on 3.2.4). Separate tables: each has
    columns the others must not carry. `fn::form::check_change` (the lifecycle events): published
    versions are frozen (only `published → retired`), never deleted (the ledger points at them),
    and publish only with their text matching `textHash` and a privacy document that counts.
    Permissions: everyone reads non-drafts (api-public-read serves them; person sessions read them
    in the gate functions); only api-admin writes (no admin routes yet: dev's versions come from
    data script 0005).
29. **The ledger names the form version and statement.** `consent.form` (option, so v1 rows stay
    valid) and `type` = the statement ticked; new type `account_data`. Event `consent_form`: a
    grant needs a form version (except the migrator's `legacy_import`) that is published and counts,
    has that statement (`fn::form::statements`), and links the same `dpaVersion`. A withdrawal binds
    to the form of the grant it follows (none for a v1 grant), and is never refused for its
    statement: withdrawing is always possible (Art 7(3)). Which version is in force is the API's
    `409`, as for the DPA (D20). The evidence hash is `heisreal-consent-evidence/v2` (form,
    version, text hash, DPA and its hash, statement, event, mechanism), computed in
    `libs/consent/src/lib/evidence.ts`; v1 rows keep verifying with v1.
30. **Gate rules (D93: no form version ever hides a story).** `fn::consent::valid`, used by
    `fn::consent::granted` (so the story permissions and events, the read-model mirror and
    libs/consent's guard all follow): a grant counts on any published or retired version, whose
    privacy document counts, that has its statement; a v1 row (no form) counts. A newer version
    never stops an older grant counting. So publishing (`fn::consent::publishable`: Art 9,
    publish and 18+) depends only on the person's own ledger and dev's switches, never on which
    versions are published. Something **new** also needs the forms in force
    (`fn::consent::may_draft`, `may_submit`; the `story` create permission and `story_consent`):
    the sign-up version in force accepted (`fn::consent::signup_accepted`, both boxes on it) and no
    testimony version with `requiresAcceptanceForNewSubmissions` published after the person's
    (`fn::form::requires_acceptance`; accepting the version in force settles it, even if the
    requiring version was retired since). Editing a draft, approval and publishing don't. Testimony
    consent is per account (D85): `fn::consent::testimony_status` gives the account's version (its
    current Art 9 grant's form) against the one in force, and `acceptanceRequired`, for the
    signed-in banner. No story stores a consent version (D86). **Statements stay on their form
    (D109):** `consent_form` refuses any ledger row, grant or withdrawal, that pairs a statement
    with another form's version (`fn::form::kind_statements`): 18+ and `account_data` only on
    sign-up versions, Art 9 and `publish` only on testimony versions, `share_socials` only on
    social sharing versions. No environment holds an older such row: the form tables didn't exist
    before this change, so nothing needed withdrawing. `fn::consent::valid` checks the statement
    too, as defence in depth.
    **Sharing (D93):** `fn::consent::may_share($user, $use)` / `fn::story::may_share($story, $use)`,
    `$use` a feature column (`share…` or `allow…`): the person's latest `share_socials` event is a
    grant on a social sharing version that counts and has that column true; Art 9, publish and 18+
    count (never relaxed by D48); for a story, it is public. Anything else, including an unknown
    or odd name, is "no". Withdrawing it stops new sharing at once; D107 (A): within 30 days the
    media team removes the story from our own channels and stops paid promotion, while copies
    others made can't be controlled (the form says so). Nothing posts yet, so nothing automates it.
31. **D75: dev's placeholder privacy document and forms.** `dpaVersion.devPlaceholder`, refused by
    `dpa_dev_placeholder` unless `_setting:consent` says `devLegalPlaceholders` in dev (written by
    the runner from OpenTofu's `dev_legal_placeholders`, set only in `live/dev/cluster`; refused
    elsewhere by OpenTofu and by `_setting_dev_legal_only`). `fn::legal::counts` counts a
    placeholder, and every form linking it, only while the setting is on: a dev backup restored
    elsewhere stops counting them. Data script 0005 creates `dpaVersion:dev_placeholder` and v1 of
    the three forms, published, when the flag is on (elsewhere it records itself and writes
    nothing); social v1 allows every platform and use its words name. The dev-seed reset gives
    every fixture person real grants (sign-up 18+ and `account_data`, testimony Art 9 and
    `publish`; no social sharing) with v2 evidence, so D48's switch is off in dev.
32. **Legal texts in the database (D84).** `dpaVersion.text` and the forms' `text` hold the words
    of their files: what a person read sits beside the ledger, and api-public-read serves it
    (`GET /v1/legal/dpa`, `GET /v1/legal/forms/{signup|testimony|social}`, published only).
    OpenTofu passes each file's words and sha256; the sync files refuse a mismatch.
    `fn::legal::dpa_in_force()` is the one definition of the privacy document in force. **Upgrade
    safety (Codex, #101):** the runner's pre-checks run `dpa-sync.surql` and `form-sync.surql`
    against the previous schema with `$sync_check = true`, so they only validate and write
    nothing (the previous schema may not define `text`); the drafts follow their files after the
    schema step. `migration.int-spec.ts` migrates a database with the previous release's bundle and
    runner (from git), then this one, twice.
33. **D114: the boxes are structured data, never read from a form's words.** Each form version
    has `statements` (`[{ key, label }]`: the consent types it asks for and the exact words shown
    beside each box) and `statementsHash` (sha256 of its file,
    `libs/legal/forms/<kind>/<id>.statements.json`). OpenTofu passes every statements file decoded
    (`form_statements`) and its sha256 (`form_statements_sha256`); `form-sync.surql` copies them
    into the version (a draft follows its file) and **refuses the migration**, before the schema
    step, when a version's file is missing or doesn't list exactly the statements the version
    must have (`fn::form::required_statements`: the sign-up form's two, Art 9 and, if it covers
    publishing, `publish` on the testimony form, `share_socials` on the social sharing form), each
    once, each with words. `fn::form::check_statements` refuses the same on any write, whoever
    writes it. Published versions are frozen, with one exit: a version published before D114 (dev's
    v1 forms) gets its statements once, from its file (tested from the release before, from git).
    `fn::form::statements` (what a grant may count for) is unchanged. **Evidence v3**
    (`heisreal-consent-evidence/v3`): v2 plus the version's `statementsHash`, so the ledger proves
    the words beside the box ticked; `consent.evidenceVersion = 3` marks those rows (set by the
    API on every event since, and by dev-seed). Older rows have no marker and keep verifying as
    v2 (with a form) or v1 (without); nothing in the ledger is rewritten (it is append-only).
34. **What hides a story for consent, and the fences.** Only two things: the person withdrawing
    `publish` or Art 9 (WithdrawConsent deletes their `publicStory` rows, as since 0.8; under D88
    withdrawal will delete the account later in M2), and, in dev, D48's or D75's switch being
    turned off, or the database leaving dev (a dev backup restored elsewhere: both switches only
    count in dev), which takes away the basis the dummy consent stood on. For the latter,
    `_setting_reconcile` runs `fn::consent::reconcile` on every settings write (each migration)
    while the database is or was dev (tested: dev → `prod` hides the story, Codex, #101): a public story whose uploader's consent no longer counts is **hidden, not
    reverted**, like a media hide (item 27; `HideStory`, reason `consent_required`), and hidden
    stories it covers again come back (`RepublishStory`, reason `consent_restored`), so a
    person's later grant brings theirs back at the next dev migration. `fn::story::hidden_by_media`
    lists only stories with a media problem. **Fences:** a grant must be on the version in force,
    and a new draft or a submission checks the forms in force, which no person owns. So
    `legalFence:forms` (`PERMISSIONS NONE`) is written by every form-version write, every consent
    event (`consent_legal_fence`), every new story and every submission (`story_fence`): of two
    overlapping transactions the second to commit fails and its retry sees the new version (tested
    in both orders). The grant's own transaction also checks the version in force
    (`409 form_version_not_in_force`). Edits, approvals and publication don't write it: nothing
    they check depends on form versions. A withdrawal racing a draft conflicts on `personFence`
    (tested). When a dev switch or the environment changes, the settings write bumps `legalFence`
    and every person's fence, so any consent-dependent write overlapping it retries under the new
    setting. The runner
    writes `_setting` in its own step after the schema: on 3.2.4 a `publicStory` row deleted in
    the transaction that redefines its indexes leaves its slug in the unique index.

### M2 hearts (favourites; founder, 2026-10-25: hearts are private)

34. **`favourite`: a person's private hearts.** `person`, `story`, `createdAt`, all `READONLY`; one
    per person and story (`favourite_unique`). Permissions: only the person reads, creates and
    deletes their own rows; nobody updates them; **no service login reads them**, and neither does
    the story's owner (tested: Bob sees no row and a count of 0 on his own story). Event
    `favourite_rules`: a new heart needs a live person (`fn::person::live`, fence) and fences the
    story's owner too (Codex, #117: a heart racing the owner's erasure, which deletes the story
    and its hearts, conflicts at commit instead of outliving the story; tested), the sign-up
    consent (`account_data` and `age_18plus` granted on any version that counts, D73, D93;
    `favourite_needs_consent`) and a story public now (its `publicStory` row;
    `favourite_not_published`); deleting one bumps the person's fence. A story that stops being
    public later keeps its hearts (removable any time), and lists read `publicStory` in the
    person's session (C15), so it drops out of them. **Erasure:** `user_erasure_favourites` deletes
    the person's hearts when `gdprDeletedAt` is set (whichever service erases), and
    `story_erasure_cascade` deletes the hearts on a deleted story. api-user:
    `PUT`/`DELETE`/`GET /v1/account/favourites` (`favourites.int-spec.ts` in api-user and here).
    **Seam, not built:** the owner's count per story ("my stories", PR 8 of the M2 plan). A person
    session can't count others' rows, and functions run with the caller's permissions, so it will
    be a counter the `favourite_rules` event keeps (events run elevated) in its own table with the
    story's id, like `hiddenStory`, so hearts never bump the story's `version` (D29), readable only
    by the story's owner: a number, never who.

## Person-linked tables

Every table in `schema.surql`; `person-linked.int-spec.ts` fails if a new one isn't listed.

| Table                                                                                                                                                                                | Holds or links                                 | Class      | On create/update                                                           | After erasure                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ---------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `user`                                                                                                                                                                               | the person (Clerk id until erasure)            | root       | fence bump; binding and erasure rules (D37); `gdprDeletedAt` set by the DB | stub: id, `createdAt`, `gdprDeletedAt`                            |
| `story`                                                                                                                                                                              | testimony; `submitter`                         | linked     | submitter live + fence (and owner/consent rules)                           | deleted                                                           |
| `publicStory`                                                                                                                                                                        | published testimony; same id as the story      | linked     | story approved + mirrored + consent; submitter live + fence                | deleted (cascade)                                                 |
| `hiddenStory`                                                                                                                                                                        | hidden publish data; same id as story          | linked     | event only; submitter live + fence                                         | deleted (cascade)                                                 |
| `consent`                                                                                                                                                                            | the ledger; `subject`                          | linked     | subject live + fence; append-only                                          | kept as proof (Art 7(1)); pruned 6 years after erasure (migrator) |
| `moderationReview`                                                                                                                                                                   | feedback about a story; `story`, `moderator`   | linked     | story exists, its submitter live + fence                                   | deleted (cascade)                                                 |
| `idempotencyKey`                                                                                                                                                                     | `[service, user record, key]`; `{id, version}` | linked     | user live + fence (webhook keys exempt); people: own keys only             | deleted by erasure; others expire in 24 h                         |
| `favourite`                                                                                                                                                                          | a heart; `person`, `story`                     | linked     | person + story owner live, fenced; sign-up consent; story public; own rows | deleted (erasure event; also with the story)                      |
| `auditLog`                                                                                                                                                                           | `actor`, `entity` ids; typed codes             | kept (D38) | none: no person-state dependency, and the fields can't hold text           | kept 6 years; ids point nowhere                                   |
| `personFence`                                                                                                                                                                        | a counter keyed by user id                     | none       | written by events only; `PERMISSIONS NONE`                                 | stays (no data); can go with the stub                             |
| `legalFence`                                                                                                                                                                         | one counter (`legalFence:forms`)               | none       | written by events only; `PERMISSIONS NONE`                                 | —                                                                 |
| `tag`, `dpaVersion`, `signupFormVersion`, `testimonyFormVersion`, `socialSharingFormVersion`, `service`, `_migration`, `_migrationRun`, `_migrationPending`, `_identity`, `_setting` | no person data                                 | none       | —                                                                          | —                                                                 |

- **Audit writes that race erasure.** These are allowed to commit, because audit rows are kept
  anyway (D38). They can't carry testimony text: every field is typed or an enum, and unknown
  fields are refused. The `moderationReview.moderator` and `auditLog.actor` links point at
  staff `user` rows, which become stubs like anyone's.
- **Future tables follow the same pattern** (as `favourite` does; donors M4, helped/concern M6,
  any Bunny pending-deletions table, D40): call `fn::person::live` on create/update, bump on
  delete, and classify the table in the spec.

## Transactions, conflicts and retries (for command handlers)

- **Snapshot reads.** A transaction sees the database as it was when it began. Checks in
  permissions and events can't see a concurrent commit; the fence turns that overlap into a
  **commit-time conflict** for whichever commits second.
- **Treat a conflict as retryable.** Its message contains `Transaction conflict` and `can be
retried`. Re-run the **whole** command (re-read, re-check, re-write) with a small bounded
  backoff (e.g. 3 tries). The retry sees the committed state, so a withdrawn consent or an
  erasure now refuses it (tested). surrealdb.js `.retry()` and 2.1's `transaction([...],
{ retry })` do this for one-request transactions.
- **Erasure must retry until it commits** (D39 makes it idempotent). An erasure that loses to a
  concurrent write is retried and then erases that write too (tested). Re-running the sweep once
  after commit is a cheap extra safety net.
- **Expect more conflicts per person, not across people.** Approving someone's story while they
  edit, or two tabs of one person, now conflict. That's intended. One exception crosses people:
  every consent event, every new story and every submission writes `legalFence:forms`, as does
  every write to a consent form version (item 33), so two people's grants, new drafts or
  submissions at the same moment can conflict too, and one retries. The retries are optimistic
  (3 attempts for a plain command, 4 with an `Idempotency-Key`): they can't deadlock, but
  sustained contention could use them up.

## Gotchas (no schema change; for `libs/database` and every command handler)

- **A denied write returns an empty result, and so does an allowed one the caller can't read
  back.** For example, `api_user`/`workflow` `CREATE auditLog …` succeeds, but the result is
  `[]` because they can't `SELECT` audit rows. The same holds for `DELETE … RETURN BEFORE` on
  stories by `api_user`. "Check that the write took effect" therefore only works on tables the
  caller can read. For audit rows and erasure deletes, these integration tests are the guard.
- **Field permissions drop silently.** Moderation fields set by an owner, or content fields set
  by `api_admin`/`workflow`, succeed without the change. Changing a `READONLY` field
  (`submitter`) is an **error**. Denied events (`THROW`) are errors.
- **`$auth.id` is `NONE` in a service's queries**, because `service` is `PERMISSIONS NONE`.
  Inside PERMISSIONS clauses it resolves, so the schema works. In queries use `$auth` itself.
- **`fn::consent::current` runs with the caller's permissions in queries and permission
  clauses**, so anyone who can't read the ledger (`api_public_read`, `api_user`'s login) gets
  `NONE` ("no consent"). Inside **events** it runs elevated, so the consent events see the real
  ledger whoever writes.
- **Events run with elevated privileges.** An event fired by a person's or service's write can
  write any table. Keep events small and deliberate.
- **A `RETURN` inside a transaction commits it early** and skips the statements after it
  (3.2.4), wherever it hides: `[RETURN 1]`, `1 + RETURN 1`, `IF … THEN RETURN … END`, blocks.
  **`BREAK`/`CONTINUE` in an `IF` or `FOR` block skip the rest of that block** while the
  transaction goes on and commits. In a function, event, field or param body neither can affect
  the caller (tested). So data scripts follow an allow-list of statements and may not contain
  these words at all, schema files are DDL only, and every step ends with its marker, is
  count-checked, and counts as rolled back only when the server refused its `COMMIT`. **Comments
  end at U+0085, U+2028 and U+2029 too**, so bundled files may contain no control or separator
  characters, and only ASCII outside strings. **`/'/` is a regex literal** (it can hold quotes),
  and `r""`, `u''`, `d''`, `b""`, `s''` are prefixed strings: the runner refuses both, and every step
  ends with a nonce it must get back. **A bare record path (`table:id.field`) in an `IF`
  fails** ("Specify a database to use"); `LET` it first. **`SLEEP` needs root.** **`FOR $x IN (SELECT …)` fails** ("Cannot
  execute statement using value"); `LET` the rows, then loop. **`REMOVE USER` doesn't end that
  user's open sessions**: the cutover is a restart (infra/k8s/surrealdb/README.md). **A startup
  `--import-file` with `OPTION IMPORT` hangs the server**, and a failing statement in it is only
  logged. **`surreal import` requires
  `OPTION IMPORT`**, which switches off events and field `VALUE`/`ASSERT`, so it can't run data
  scripts; the runner uses `/rpc` instead.
- **A bound variable shadows a `DEFINE PARAM` inside functions** (3.2.4): `RETURN fn::x()`
  where `fn::x` reads `$p` sees the caller's `$p`. Never use a defined param for anything a
  caller mustn't control; use a row (D48's `_setting`).
- **`array<object>` items accept undefined keys**, unlike top-level fields or nested objects
  (`image.junk` is refused, `media[0].junk` is stored). Check keys explicitly (D53).
- **`REMOVE FIELD` leaves the stored values**, and later writes keep them. Clean up or check
  with a data script.
- **Re-defining a full-text index over rows can make the COMMIT fail with a retryable conflict**
  (3.2.4 + RocksDB, seen re-running the schema with a `publicStory` row): the migration runner
  retries such a step (0.9).
- **In a failed transaction, surrealdb.js 2.0.x's `collect()` throws "The query was not
  executed due to a failed transaction"**, not the `THROW` message. Read `.responses()` for the
  root cause. 2.1.0 fixes this (surrealdb.js#689).

## Per-request person sessions (surrealdb.js)

SurrealDB 3.x multiplexes **sessions on one WebSocket connection**, and surrealdb.js 2.x
exposes them (`Features.Sessions`). **Recommended for api-user:** one long-lived connection
per instance, signed in as `service:api_user`, and per request (`withPersonSession` in
`libs/database`, used by `PersonSessions` in `libs/consent`):

```ts
const session = await connection.newSession(); // fresh: no identity at all
try {
  await session.authenticate(clerkToken); // throws if rejected; ns/db come from the token
  return await work(session); // only this request's queries
} finally {
  await session.invalidate(); // 2.0.8: cancels the renewal timer (see below)
  await session.closeSession(); // detaches the session on the server
}
```

**Concurrency, as tested:**

- **Interleaving on a shared session.** If requests call `authenticate()` on a shared session
  (or on the connection itself), they **do** interleave: A authenticates, B authenticates, A's
  query runs as B and sees B's drafts. Auth state belongs to the session, not the request.
- **Per-request sessions don't interleave.** 60 concurrent requests for two people on one
  connection each saw only their own rows. The connection stayed `service:api_user`, and
  `sessions()` was back to baseline afterwards.
- **Use `newSession()`, never `forkSession()`.** A fork inherits the service login. If the
  person's token is then rejected, the fork **keeps running as `service:api_user`**. A rejected
  token on a `newSession()` leaves a session that can't run any query ("Anonymous access not
  allowed").
- **2.0.8 renewal-timer leak.** A session closed without `invalidate()` leaves its token-renewal
  timer running; at expiry it emits an `error` event on the connection. 2.1.0 cancels it on
  close (surrealdb.js#688). `withPersonSession` always invalidates first. (The SDK-diagnostic
  test that pinned this was removed in #79: it waited on timers it couldn't control, and it
  tested the SDK, not our behaviour.)
- **Service sign-in typing.** `connect({ authentication })` in 2.0.8 is typed for system users
  and tokens only, but the runtime signs in with record access (`access: 'svc'`). That path is
  needed so the SDK re-signs in after reconnects and the 15-minute token expiry. 2.1.0 types it.
  `libs/database` signs in this way (`serviceSignIn`).
- **Reconnects aren't covered yet:** the harness disables them. See "Remaining risks" for what M2
  must check.
- **One socket for all requests.** It handles all of an instance's concurrency (Cloud Run allows
  up to 80). Requests are multiplexed by id, but a slow query doesn't block others. A small pool
  isn't required for correctness; consider it only if profiling shows head-of-line effects.

**Cost.** Mean of 200 sequential requests, `SELECT id FROM story` as a person, local Docker
(12 cores), surrealdb.js 2.0.8, one pre-signed token:

| Approach                                              | ms per request |
| ----------------------------------------------------- | -------------- |
| New session on a shared WS connection (above)         | 2.3            |
| New WS connection per request                         | 3.7            |
| HTTP `/sql` with `Authorization: Bearer` (keep-alive) | 1.4            |
| Baseline: same query on the service session           | 0.5            |

A session costs 4 extra round trips on 2.0.8: attach, authenticate, invalidate, detach. Cloud
Run → GKE latency multiplies that, so expect a few ms per personal request.

**Alternative: HTTP with a per-call token.** surrealdb.js 2.1.0's `.as(token)` (surrealdb.js#688)
sends one stateless request with the person's token, so there's no session state to leak or
interleave. It's the fastest above. But it's HTTP-engine only, and it doesn't support
`beginTransaction()` (only one-request `transaction([...])`). The test does this with raw
`fetch`.

**Recommendation for M2:** upgrade to **surrealdb.js ≥ 2.1.1** (released 2026-10-10; check it
against pnpm's minimum release age when upgrading). That upgrade affects the apps, so it's not
done here.

- **Then:** keep WS sessions for commands that need interactive transactions. Consider
  `.as()` over HTTP for simple personal reads.

## Erasure

Clerk's `user.deleted` webhook (Svix-signed, verified in api-user) means the person's token no
longer exists. So erasure runs on **`api_user`'s own login**, in one transaction. The `erasure`
spec has the reference:

1. Look up the user by `clerkUserId`.
2. `DELETE story WHERE submitter = $u`. This works without select permission, and the cascade
   removes `publicStory` and `moderationReview`.
3. Delete their idempotency keys (`WHERE record::id(id)[1] = $u`).
4. Set `gdprDeletedAt` (the database stamps the time) and clear `clerkUserId` in one update
   (D37). From then on `AUTHENTICATE` can't find them. The same update deletes their hearts
   (`user_erasure_favourites`), and step 2 deleted the hearts others gave their stories.

**What is race-safe, exactly.** Only the **linked** tables in "Person-linked tables" are covered:

- a write to them for an erased person is refused, even from a session opened before erasure;
- a write that overlaps erasure fails at commit;
- if erasure itself loses that race, it's retried.

Audit rows (kept) may commit alongside erasure by design. Anything outside SurrealDB (Bunny,
Clerk) is application ordering (D39/D40). 5. Write an `EraseAccount` audit row with `reason` = the caller (D39).

**What remains:**

- the consent ledger, proof of consent (Art 7(1)); nobody but the migrator can delete it;
- a stub `user` row (internal id, `createdAt`, `gdprDeletedAt`) that the ledger points to; no
  Clerk id (D37);
- audit rows, typed, with ids only, including the deleted stories' ids (D38).

**Retention (D38, decided 2026-10-19).** Audit and consent records are kept 6 years (the usual UK
limitation period; for an erased person, counted from erasure), then deleted by a nightly
clean-up job running as the migrator.

- **Consent:** the schema enforces the rule (item 12), and the job's `DELETE` statement is
  tested.
- **Audit:** only the migrator can delete; the 6-year cut-off lives in the job.

The job itself isn't built yet; it will run as the migrator.

**Decided, not built (M2 API work):**

- **D39.** One idempotent erasure function with three callers: in-app account deletion, Art 9
  consent withdrawal and Clerk's `user.deleted` webhook. In-app deletion erases the database
  first, then deletes the Clerk user, and returns 202. The transaction above is the database
  half; it runs on api_user's service login, since a person session can't delete stories.
- **D40.**
  - Bunny video and image ids go into a pending-deletions table in the erasure transaction.
    api-user deletes them from Bunny and removes each row; a scheduled job retries failures. The
    table isn't added here.
  - Backups age out after `backup_retention_days`.
  - Each erasure writes a Cloud Logging entry with internal ids only, and the restore runbook
    replays those entries.

**Accepted risk (D13).** A compromised `api_user` can erase anyone (destructive, not a
disclosure). The backup restores it; D40's erasure log makes sure erased people stay erased
after a restore.

## Clerk side

SurrealDB needs `ns`, `db` and `ac` claims, signed RS256 by a key it holds. GKE has no egress, so
`KEY '<PEM>'` is pinned by OpenTofu; there's no JWKS URL.

**Option 1, chosen and applied in 0.5: customise the default session token.** In Dashboard → Sessions →
Customize session token (or `clerk config patch`), add static claims:

```json
{ "ns": "heisreal", "db": "main", "ac": "clerk" }
```

That is 42 bytes of the recommended 1.2 KB budget.

- **Why it should work.** Clerk allows any custom claims except its defaults (`azp exp fva iat
iss jti nbf sid sub v pla fea sts`), and none of those collide.
- **Why it's preferred.** The browser's normal `getToken()` token then works for api-user's JWT
  guard and for SurrealDB, so there's one token per request, refreshed by Clerk every 60 s.
- **Tested.** The test tokens carry all of Clerk's v2 default claims plus these three, and
  SurrealDB accepts them.

**Option 2: a JWT template** (e.g. `surrealdb`) with the same claims, fetched with
`getToken({ template: 'surrealdb' })`.

- Templates default to a 60 s lifetime and 5 s clock skew.
- They can't override the default claims, and they don't carry session claims (`sid`, `v`,
  `pla`, `fea`), so the browser would send two tokens, or api-user would verify a template
  token.
- Clerk notes extra generation latency. Use this only if Option 1 is refused for these claim
  names.

**Public key.** It's on the Dashboard's API keys page ("JWKS Public Key", PEM), also at
`https://api.clerk.com/v1/jwks` and `<frontend-api>/.well-known/jwks.json`. It's pinned in
`infra/terraform/live/dev/cluster/clerk.auto.tfvars` (`clerk_jwt_public_key`, since 0.5). Empty,
the migration removes `DEFINE ACCESS clerk`, so no token can open a person session.

**As built in 0.5** (`infra/clerk/dev.json`, `libs/auth`): the session token carries
`{ "ns": "heisreal", "db": "main", "ac": "clerk", "role": "{{user.public_metadata.role || 'User'}}" }`.
api-user and api-admin verify it with the same pinned key before it reaches SurrealDB (signature,
`exp`/`nbf`/`iat`, `iss`, `azp`, role). api-user creates the person's `user` row on its own
login on first use (`provisionPerson`), so `AUTHENTICATE` finds them. `libs/auth/integration`
tests this end to end.

**Sources:**

- https://clerk.com/docs/guides/sessions/customize-session-tokens (custom claims, 1.2 KB)
- https://clerk.com/docs/guides/sessions/session-tokens (default v2 claims, size limits)
- https://clerk.com/docs/guides/sessions/jwt-templates (templates: lifetime, default claims,
  no override)
- https://clerk.com/docs/guides/sessions/manual-jwt-verification (RS256, PEM public key,
  `exp`/`nbf`/`azp` checks)

**Proven in 0.5** (a real dev-instance token, `libs/auth/src/lib/fixtures`): the instance
accepts `ns`/`db`/`ac`/`role` as custom session claims, and its tokens are RS256, signed by the
pinned PEM, about 900 bytes. Key rotation has a runbook (`infra/clerk/README.md`).

**Still unproven:**

- Svix webhook verification and the `user.deleted` payload (M2);
- clock skew between Clerk and the cluster in practice (SurrealDB enforces `exp`/`nbf`; Clerk
  tokens live 60 s with `nbf` 5 s in the past);
- a browser token opening a person session on the dev cluster (0.9 has the first page that could;
  api-user isn't deployed yet).

**SurrealDB checks neither `iss` nor `azp`**, as tested. The pinned key alone ties tokens to the
Clerk instance, so dev and prod must have different keys (they do). `libs/auth` checks both
before a token reaches SurrealDB. An `AND $token.iss = '<frontend-api>'` in `AUTHENTICATE` is cheap extra hardening if
wanted.

## Remaining risks

- **Reconnects are untested.** The harness connects with `reconnect: false`. What M2 must check
  against a restarted SurrealDB:
  - surrealdb.js re-attaches and restores every open session after a reconnect;
  - a per-request person session whose token expired meanwhile ends up **invalidated, not
    re-authenticated as the service**: `#applyAuthentication` falls back to the connection's
    auth provider unless the session was authenticated by hand;
  - in-flight requests fail cleanly;
  - the service connection signs in again through its `svc` provider (the 15-minute token).
- **A session opened before erasure can still read** the person's own consent rows (their
  stories are gone) until it expires, at most 5 minutes. Writes are refused, or fail at commit if
  they overlap erasure; reads aren't blocked.
- **Editing an approved story** (API plan assumption, M2): the read model must mirror the story,
  and only the person can change content. So an edit after approval needs the
  revision → re-approval flow before `publicStory` changes.
- **Errors vs empty results vs conflicts.** Consent and lifecycle rules are events, so they throw
  errors. Ownership and field scope are permissions, so they give empty results or dropped
  fields. Overlapping transactions give a retryable conflict at commit. Command handlers must
  handle all three.
- **Races outside one database transaction.** The fence covers everything inside SurrealDB.
  These are application-level ordering, not database races:
  - Bunny deletions (D40's pending-deletions table and retries);
  - Clerk deletion (D39: database first);
  - an upload to Bunny that finishes after erasure: its id is written by a later story update,
    which the fence and `gdprDeletedAt` refuse, so the video is orphaned on Bunny until the
    D40 sweep.
- **Silent no-ops.** Every handler must check that its write took effect, and that check can't
  see writes to tables it can't read (above). Put a helper in `libs/database` when the first
  command lands.
- **OWNER can still remove the guard events.** The migrator and the backup (VIEWER, reads
  everything, including consent) are trusted in-cluster system users.
- **The two 3.2.4 bugs.** The pinned tests catch an upgrade that changes them; nothing catches
  new code using the buggy patterns except review.
- **No test-runner realm fix any more.** Under Jest, surrealdb.js couldn't encode a `Uuid` (its
  sandboxed `Uint32Array` didn't match the host `ArrayBuffer`) without a setup file. The
  integration tests run on Vitest since the NestJS 12 upgrade, in Node's own realm, so that file
  is gone.
