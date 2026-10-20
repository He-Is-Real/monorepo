# Database permissions: D13 + D27 spike

Spike for D24 step 3 (`project/context/research/m0-schema-consent-decisions.html`, D13 B and
D27 B). It proves the draft `schema.surql` permission model on **SurrealDB v3.2.4** (the
digest the cluster runs) with **surrealdb.js 2.0.8** (the version in the lockfile), using
automated tests. It also records what had to change in the draft and what is still unproven.

## Where it lives and how to run it

| Path                                        | What                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `libs/database/schema/schema.surql`         | Declarative schema (D14). Terraform placeholder: `${clerk_jwt_public_key}` |
| `libs/database/schema/data/000N-*.surql`    | Run-once seeds 0001 (draft DPA v1) and 0002 (legacy DPA)                   |
| `libs/database/integration/*.int-spec.ts`   | 191 integration tests against a real SurrealDB                             |
| `libs/database/jest.integration.config.cts` | Their Jest config, kept apart from the unit tests                          |

```bash
pnpm nx run database:test-integration    # needs Docker; about 20 s
```

- **Why `libs/database/schema` and not `infra/db`** (the doc's D14 layout): files under an Nx
  project make it "affected", so any schema change runs `test-integration` in CI. Next to the
  client code, the schema and the code that queries it change in the same PR. The migration
  Job (D14) can still read these files from Terraform by relative path.
- **The container.** Jest's global setup runs `docker run` with the image read from
  `infra/k8s/surrealdb/base/kustomization.yaml` (tag + digest). The tests therefore always use
  the version the cluster runs, and there's one pin to bump. The root password is random per
  run. Set `SURREAL_TEST_URL` / `SURREAL_TEST_USER` / `SURREAL_TEST_PASS` to use a running
  server instead.
- **Isolation.** Each spec file gets its own namespace, so the files run in parallel.
- **Setup.** An OWNER `migrator` applies the schema and seeds, as the D14 Job will. Each
  service gets a `service` record with a random password, argon2-hashed by
  `crypto::argon2::generate`. Clerk is simulated by an RS256 key pair generated per run; the
  public PEM is pinned into `DEFINE ACCESS clerk` exactly as Terraform will pin Clerk's.
- **Kept out of `test`.** `nx affected -t test` still runs without Docker; CI has a separate
  `nx affected -t test-integration` step. CI uses no `services:` container because it can't
  pass SurrealDB its `start` arguments. No new dependencies.

## What was proven

Every **denied write** asserts the empty result **and** checks through the migrator (which
bypasses permissions) that the row is unchanged or absent.

| Claim                                                                                                                                                                                                                                                                                                                                                                                                                        | Spec                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Schema (draft 122 statements, now 142) applies and re-applies cleanly; seeds run once.                                                                                                                                                                                                                                                                                                                                       | `schema`                         |
| Only the migrator (OWNER) can `DEFINE`/`REMOVE` anything. Every service and person session is refused `DEFINE TABLE/FIELD/ACCESS/USER/FUNCTION`, `REMOVE EVENT`, `REMOVE TABLE`. The guard events are still present afterwards.                                                                                                                                                                                              | `schema`                         |
| `svc` sign-in: argon2 hashes only. Wrong password, another service's password and unknown names are rejected. No service can read, rewrite or create `service` rows.                                                                                                                                                                                                                                                         | `service-permissions`            |
| `api_public_read`: only `publicStory`, `tag` and published `dpaVersion`. Nothing in `story` (not even approved rows), `consent`, `user`, reviews, audit, idempotency keys or `_migration`. Every write is a no-op.                                                                                                                                                                                                           | `service-permissions`            |
| `api_user` login: can't read, create, edit or reassign stories, or read or forge consent. It can delete stories (erasure), create/update users but not rebind or clear `clerkUserId` outside erasure, write but not read audit rows, own idempotency keys, and can't moderate.                                                                                                                                               | `service-permissions`            |
| `api_admin`: reads all stories, consent, reviews and audit; can't write consent; manages DPAs (published = frozen, none deletable); links a legacy person's Clerk ID once.                                                                                                                                                                                                                                                   | `service-permissions`            |
| D41 write scope: `workflow` writes media/processing fields only; content, status, approval, lock and feedback writes are dropped. `api_admin` writes moderation fields and status only; content and media writes (including `media[0].x`) are dropped, and `publicStory` must mirror the approved story.                                                                                                                     | `write-scope`                    |
| Consent is append-only for every identity: permissions give an empty result; even the OWNER migrator is stopped by the event.                                                                                                                                                                                                                                                                                                | `service-permissions`, `consent` |
| Clerk JWT (D27): `sub` maps to `user` by `clerkUserId`. Rejected: expired, wrong key, `ac` = `svc` or unknown, unknown `sub`, other database, no `exp`, HS256-with-public-key confusion, tampered payload, erased person. An `id` claim can't override `AUTHENTICATE`; `iss`/`azp` aren't checked.                                                                                                                           | `person-session`                 |
| A person sees only their own stories (drafts and pending too), never anyone else's in the write model, approved included. They see only their own consent and user row, and only published DPAs. `fn::consent::current(otherUser)` returns nothing to them.                                                                                                                                                                  | `person-session`                 |
| Draft creation: only for themselves, only as `draft`, only with current Art 9 consent. Moderation fields can't be pre-filled; `version`/`createdAt`/`submittedAt` are server-set.                                                                                                                                                                                                                                            | `person-session`                 |
| Editing: own drafts only; `submitter` can't be reassigned; moderation fields are silently dropped; only submit or withdraw is allowed; no backdated `submittedAt`. Content is locked after submit, editable again after `changes_requested`. They can't delete stories, can withdraw (and unpublish) their own, and can't touch others'.                                                                                     | `person-session`                 |
| Consent at every step: edit/media needs current Art 9; submit and approval need Art 9 + `publish` + `age_18plus`; the read model needs them too. Withdrawing a story needs none. Includes Codex's reproduction (withdraw Art 9, then edit, submit, approve: all refused, nothing published).                                                                                                                                 | `consent-gates`                  |
| D17 derivation over many people and stories: grant, re-grant to a newer DPA, withdraw and re-consent each change every one of that person's stories at once, and nobody else's. Correct in multi-row selects, in subqueries and in the person's own view.                                                                                                                                                                    | `consent`                        |
| D20/D22: no consent against a draft DPA (accepted once published). `occurredAt` is server time. Legacy consent (mechanism, legacy DPA, `legacyGivenAt`) is migrator-only. The 0003 import pattern derives `legacy-squarespace`.                                                                                                                                                                                              | `consent`                        |
| Both 3.2.4 bugs are pinned (they fail when an upgrade fixes them).                                                                                                                                                                                                                                                                                                                                                           | `consent`                        |
| Erasure on `api_user`'s login removes stories, read-model rows, reviews and idempotency keys, clears `clerkUserId` and leaves a stub `user` row, the consent ledger (pointing at the stub) and id-only audit rows. Fresh sign-in fails; nobody can rebind or un-erase the stub. A session opened before erasure can't write; an overlapping transaction fails at commit (see `concurrency`). Works after consent withdrawal. | `erasure`                        |
| D38: audit rows have typed, enum-checked fields; a payload or any unknown field is refused, as are free-text actions, reasons, statuses, roles and consent types.                                                                                                                                                                                                                                                            | `erasure`                        |
| Concurrency (round 2): a story create overlapping erasure, an approval overlapping a publish withdrawal, a submit overlapping an Art 9 withdrawal, and a workflow media write overlapping erasure all lose at commit with a retryable conflict, with stored state clean. Erasure losing to a create is retried and then erases it. Unrelated people never conflict. No session can read or write a fence.                    | `concurrency`                    |
| Service writes check the **submitter's** consent: workflow media/processing writes (draft and approved) are refused once Art 9 is withdrawn, stored state unchanged. Moderation without content change, withdrawal and deletion stay consent-free.                                                                                                                                                                           | `consent-gates`                  |
| D38 retention: only the migrator, and only for subjects erased more than 6 years ago (2192 days), can delete consent; live, recently erased and 2191-day-old subjects are refused, and so is every service and person. Audit rows: the migrator can prune; no service or person can.                                                                                                                                         | `retention`                      |
| One connection, one session per request, concurrent people isolated; dangers pinned; cost measured.                                                                                                                                                                                                                                                                                                                          | `request-sessions`               |

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
   `action` list is the API plan's commands plus `LinkLegacyUser` and workflow's `ProcessMedia`.
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
  edit, or two tabs of one person, now conflict. That's intended.

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
- **In a failed transaction, surrealdb.js 2.0.x's `collect()` throws "The query was not
  executed due to a failed transaction"**, not the `THROW` message. Read `.responses()` for the
  root cause. 2.1.0 fixes this (surrealdb.js#689).

## Per-request person sessions (surrealdb.js)

SurrealDB 3.x multiplexes **sessions on one WebSocket connection**, and surrealdb.js 2.x
exposes them (`Features.Sessions`). **Recommended for api-user:** one long-lived connection
per instance, signed in as `service:api_user`, and per request:

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
  timer running; at expiry it emits an `error` event on the connection (pinned by a test). 2.1.0
  cancels it on close (surrealdb.js#688).
- **Service sign-in typing.** `connect({ authentication })` in 2.0.8 is typed for system users
  and tokens only, but the runtime signs in with record access (`access: 'svc'`). That path is
  needed so the SDK re-signs in after reconnects and the 15-minute token expiry. 2.1.0 types it.
  `libs/database` today signs in as a system user, so it changes when services move to `svc`.
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
3. Delete their idempotency keys.
4. Set `gdprDeletedAt` and clear `clerkUserId` in one update (D37). From then on
   `AUTHENTICATE` can't find them. An already-open session can't write afterwards, and a
   transaction that overlaps erasure fails at commit (person fence). If erasure itself loses
   that race, it's retried.
5. Write an `EraseAccount` audit row with `reason` = the caller (D39).

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

The job itself comes with the D14 migration work; it isn't built.

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
`KEY '<PEM>'` is pinned by Terraform; there's no JWKS URL.

**Option 1, preferred: customise the default session token.** In Dashboard → Sessions →
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
`https://api.clerk.com/v1/jwks` and `<frontend-api>/.well-known/jwks.json`. Terraform passes it
as `clerk_jwt_public_key`.

**Sources:**

- https://clerk.com/docs/guides/sessions/customize-session-tokens (custom claims, 1.2 KB)
- https://clerk.com/docs/guides/sessions/session-tokens (default v2 claims, size limits)
- https://clerk.com/docs/guides/sessions/jwt-templates (templates: lifetime, default claims,
  no override)
- https://clerk.com/docs/guides/sessions/manual-jwt-verification (RS256, PEM public key,
  `exp`/`nbf`/`azp` checks)

**Unproven until 0.5 (no Clerk instance in this spike):**

- that the dev instance accepts `ns`/`db`/`ac` as custom session claims, and that its tokens
  are RS256 with the dashboard PEM;
- the real token size;
- key rotation: a rotated Clerk key breaks every person session until Terraform re-pins the
  PEM, so a runbook is needed;
- Svix webhook verification and the `user.deleted` payload;
- clock skew between Clerk and the cluster (SurrealDB enforces `exp`/`nbf`; Clerk tokens live
  60 s).

**SurrealDB checks neither `iss` nor `azp`**, as tested. The pinned key alone ties tokens to the
Clerk instance, so dev and prod must have different keys (they do). api-user's Clerk guard must
check `azp`. An `AND $token.iss = '<frontend-api>'` in `AUTHENTICATE` is cheap extra hardening if
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
- **Jest-only quirk.** In Jest's VM, surrealdb.js can't encode a `Uuid`: its sandboxed
  `Uint32Array` doesn't match the host `ArrayBuffer`, so `newSession()` hangs. Fixed for the
  tests by `integration/support/host-typed-arrays.ts`. It doesn't affect production, but any
  future Jest test using sessions or Uuid parameters needs the same setup file.
