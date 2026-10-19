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
| `libs/database/integration/*.int-spec.ts`   | 133 integration tests against a real SurrealDB                             |
| `libs/database/jest.integration.config.cts` | Their Jest config, kept apart from the unit tests                          |

```bash
pnpm nx run database:test-integration    # needs Docker; about 10 s
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

| Claim                                                                                                                                                                                                                                                                                                                                    | Spec                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Schema (draft 122 statements, now 123) applies and re-applies cleanly; seeds run once.                                                                                                                                                                                                                                                   | `schema`                         |
| Only the migrator (OWNER) can `DEFINE`/`REMOVE` anything. Every service and person session is refused `DEFINE TABLE/FIELD/ACCESS/USER/FUNCTION`, `REMOVE EVENT`, `REMOVE TABLE`. The guard events are still present afterwards.                                                                                                          | `schema`                         |
| `svc` sign-in: argon2 hashes only. Wrong password, another service's password and unknown names are rejected. No service can read, rewrite or create `service` rows.                                                                                                                                                                     | `service-permissions`            |
| `api_public_read`: only `publicStory`, `tag` and published `dpaVersion`. Nothing in `story` (not even approved rows), `consent`, `user`, reviews, audit, idempotency keys or `_migration`. Every write is a no-op.                                                                                                                       | `service-permissions`            |
| `api_user` login: can't read, create, edit or reassign stories, or read or forge consent. It can delete stories (erasure), create/update users but not rebind `clerkUserId`, write but not read audit rows, own idempotency keys, and can't moderate.                                                                                    | `service-permissions`            |
| `api_admin`: reads all stories, consent, reviews and audit; moderates; can't write consent; manages DPAs (published = frozen, none deletable); links a legacy person's Clerk ID once.                                                                                                                                                    | `service-permissions`            |
| `workflow`: reads and updates stories, reads consent. Can't create, delete or publish stories, write consent, or read audit or reviews.                                                                                                                                                                                                  | `service-permissions`            |
| Consent is append-only for every identity: permissions give an empty result; even the OWNER migrator is stopped by the event.                                                                                                                                                                                                            | `service-permissions`, `consent` |
| Clerk JWT (D27): `sub` maps to `user` by `clerkUserId`. Rejected: expired, wrong key, `ac` = `svc` or unknown, unknown `sub`, other database, no `exp`, HS256-with-public-key confusion, tampered payload, erased person. An `id` claim can't override `AUTHENTICATE`.                                                                   | `person-session`                 |
| A person sees only their own stories (drafts and pending too), never anyone else's in the write model, approved included. They see only their own consent and user row, and only published DPAs. `fn::consent::current(otherUser)` returns nothing to them.                                                                              | `person-session`                 |
| Draft creation: only for themselves, only as `draft`, only with current Art 9 consent. Moderation fields can't be pre-filled; `version`/`createdAt`/`submittedAt` are server-set.                                                                                                                                                        | `person-session`                 |
| Editing: own drafts only; `submitter` can't be reassigned; moderation fields are silently dropped; only submit or withdraw is allowed; no backdated `submittedAt`. Content is locked after submit, editable again after `changes_requested`. They can't delete stories, can withdraw (and unpublish) their own, and can't touch others'. | `person-session`                 |
| D17 derivation over many people and stories: grant, re-grant to a newer DPA, withdraw and re-consent each change every one of that person's stories at once, and nobody else's. Correct in multi-row selects, in subqueries and in the person's own view.                                                                                | `consent`                        |
| D20/D22: no consent against a draft DPA (accepted once published). `occurredAt` is server time. Legacy consent (mechanism, legacy DPA, `legacyGivenAt`) is migrator-only. The 0003 import pattern derives `legacy-squarespace`.                                                                                                          | `consent`                        |
| Both 3.2.4 bugs are pinned (they fail when an upgrade fixes them).                                                                                                                                                                                                                                                                       | `consent`                        |
| Erasure on `api_user`'s login removes stories, read-model rows, reviews and idempotency keys, and leaves the consent ledger, a `user` tombstone and id-only audit rows. The person's token stops working.                                                                                                                                | `erasure`                        |
| One connection, one session per request, concurrent people isolated; dangers pinned; cost measured.                                                                                                                                                                                                                                      | `request-sessions`               |

## Changes to the draft schema (port back to the decision doc)

`git diff aa7d671 -- libs/database/schema/` shows exactly these. The seeds are unchanged.

1. **Bug: `story.consent` used `$parent.submitter`.** On 3.2.4, when a story is read **inside a
   subquery**, a COMPUTED field's `$parent` is the outer query's record. So
   `SELECT (SELECT consent FROM story WHERE …) FROM user` derived `NONE` for every story. That
   fails closed, but it's wrong. **Fix:** use the record's own field:
   `fn::consent::current(submitter, …)`. It's correct both at the top level and in subqueries.
2. **Gap: drafts could be created without Art 9 consent.** The create permission is now
   `submitter = $auth.id AND status = 'draft' AND fn::consent::current(submitter,
'special_category_religious').event = 'granted'`. The D21 guard stays the primary check;
   this is defence in depth for the one write that first stores Art 9 data.
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

## Gotchas (no schema change; for `libs/database` and every command handler)

- **A denied write returns an empty result, and so does an allowed one the caller can't read
  back.** For example, `api_user`/`workflow` `CREATE auditLog …` succeeds, but the result is
  `[]` because they can't `SELECT` audit rows. The same holds for `DELETE … RETURN BEFORE` on
  stories by `api_user`. "Check that the write took effect" therefore only works on tables the
  caller can read. For audit rows and erasure deletes, these integration tests are the guard.
- **Field permissions drop silently.** `UPDATE user SET clerkUserId = …` from `api_user`, or
  moderation fields set by an owner, succeed without the change. Changing a `READONLY` field
  (`submitter`) is an **error**. Denied events (`THROW`) are errors.
- **`$auth.id` is `NONE` in a service's queries**, because `service` is `PERMISSIONS NONE`.
  Inside PERMISSIONS clauses it resolves, so the schema works. In queries use `$auth` itself.
- **`fn::consent::current` runs with the caller's permissions.** That's correct, but anyone who
  can't read the ledger (`api_public_read`, `api_user`'s login) gets `NONE`, meaning "no
  consent".
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
4. Set `gdprDeletedAt`, which makes `AUTHENTICATE` reject their tokens.
5. Write an `EraseAccount` audit row.

**What remains:**

- the consent ledger (proof of consent; nobody can delete it);
- the `user` row, as a tombstone holding `clerkUserId`, `createdAt` and `gdprDeletedAt` (nobody
  can delete it);
- audit rows, which hold ids only, including the deleted stories' ids.

**Open questions:**

- **`clerkUserId` after erasure.** Should it be kept after Clerk deletes the account? It's
  pseudonymous, but it is what links the retained ledger to the person. `api_user` can't clear
  it (field permission), and only the migrator could. A legal/DPO call for the retention map.
- **Story ids in the audit log.** Should audit rows keep the deleted stories' ids, and how long
  until retention pruning (migrator)?
- **Account deletion from the app.** `DELETE /v1/account` (EraseAccount from the app) must also
  run on the service login: a person session can't delete stories. It should probably delete the
  Clerk user and let the webhook do the rest.
- **Accepted risk (D13).** A compromised `api_user` can erase anyone (destructive, not a
  disclosure). The nightly backup restores, but a restore would also resurrect erased people. A
  separate erasure job would remove the risk.
- **Media and backups.** Bunny.net videos and backups aren't covered by the database and need
  their own erasure step and retention note.

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

- **`workflow` can update any story field.** The D13 diagram said "story.media only (M7)", but
  the matrix and schema give it table-level update, and moderation fields too. Narrow it with
  field permissions in M7.
- **`api_admin` can update any story field**, including content, which is needed for edits after
  approval. There is no "reviewed version = published version" check beyond the owner content
  lock.
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
