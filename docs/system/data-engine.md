# Data: SurrealDB engine behaviour, person sessions and Clerk

Covers: the SurrealDB 3.2.4 and surrealdb.js 2.0.8 behaviour the schema and the services rely on, per-request person sessions, and what SurrealDB needs from Clerk; logins and tables are in [data-model.md](data-model.md).
Data: `libs/database/schema` is the source of truth; `libs/database/integration/engine-gotchas.int-spec.ts` pins most rules here.
Next id: REQ-DBE-044

## Contents

- Engine gotchas: permissions and sessions
- Engine gotchas: fields and values
- Engine gotchas: queries and indexes
- Engine gotchas: transactions and scripts
- Per-request person sessions
- Clerk side

Each gotcha names in brackets the spec that pins it; `engine-gotchas` pins them on scratch tables, so
after an engine upgrade a failure there says which gotcha changed. Ones with no spec are relied on by
the schema and caught only by review.

- **REQ-DBE-001** When SurrealDB is upgraded, the gotchas below with no pinning spec are re-checked by hand, since they could change silently. [J-2026-11-06b-DB]

## Engine gotchas: permissions and sessions

- **REQ-DBE-002** A write the permissions deny returns an empty result, not an error; so does an allowed write on a table the caller can't read back (api-user's `DELETE … RETURN BEFORE` on stories returns `[]`). (`write-scope`, `service-permissions`) [D13]
- **REQ-DBE-003** Field permissions drop a write silently; a `READONLY` change and an event `THROW` are errors. (`write-scope`, `service-permissions`) [D13]
- **REQ-DBE-004** Every rule and query compares `$auth` itself (`submitter = $auth`, `$auth IN [service:…]`), never `$auth.id`. (`engine-gotchas`; `public-view` counts every readable table without a WHERE) [J-2026-11-06b-DB]
  Why: in a `service` session `$auth.id` is NONE, and `SELECT count() … GROUP ALL` without WHERE skips a row rule reading it.
- **REQ-DBE-005** Events run with elevated privileges, so an event fired by a person's write can write a `PERMISSIONS NONE` table; events are trusted code, kept small and deliberate. (`engine-gotchas`) [J-2026-11-06b-DB]
- **REQ-DBE-006** A function runs with the caller's permissions in queries and permission clauses (it sees nothing the caller can't: fail closed), but elevated inside events. (`engine-gotchas`) [J-2026-11-06b-DB]
- **REQ-DBE-007** Row and field rules can follow links both ways without recursing: the story's rule reads `currentStatus.status`, the entry's rule reads `story.currentStatus`. (`public-view`) [R6]
- **REQ-DBE-008** In a person's session, api-user's story reads alias the id `storyRef`, never `<string> id AS id`, and ORDER BY selects the ordered field under its own name. [D27]
  Why: aliasing `id` changed what `id` meant to the query's other fields with subqueries and ORDER BY.
- **REQ-DBE-009** `REMOVE USER` doesn't end that user's open sessions, so a login cutover is a restart (`infra/k8s/surrealdb/README.md`). (`migration`) [D43]

## Engine gotchas: fields and values

- **REQ-DBE-010** `$auth` is usable in a field `VALUE`. [D13]
- **REQ-DBE-011** Server-controlled fields use `VALUE` (… `READONLY`), never `DEFAULT`, which accepts a client-supplied value. (`engine-gotchas`) [J-2026-11-06b-DB]
- **REQ-DBE-012** A field `VALUE` also runs for a nested `SET` (`SET a.b = …`), with `$value` the whole new field and `$before` the old one. (`engine-gotchas`) [J-2026-11-06b-DB]
- **REQ-DBE-013** Inside a SELECT in a field's `VALUE`, `$this` is the row that SELECT reads, so the field binds the record first (`LET $story = $this.story`; `storyStatusLog.publishedAt`). (`public-view` checks each story keeps its own `publishedAt`) [J-2026-11-06b-DB]
- **REQ-DBE-014** Computed fields use their own record's fields directly, never `$parent`, which inside a subquery is the outer query's record. (`engine-gotchas`) [J-2026-11-06b-DB]
- **REQ-DBE-015** `array<object>` items store undefined keys (nested objects refuse them) and `REMOVE FIELD` keeps stored values, so the schema checks keys explicitly and a data script cleans up. (`engine-gotchas`) [J-2026-11-06b-DB]
- **REQ-DBE-016** Nothing a caller mustn't control lives in a `DEFINE PARAM` (`_setting:current` is a row). (`engine-gotchas`) [J-2026-11-06b-DB]
  Why: inside a function a caller's bound variable shadows a `DEFINE PARAM`.
- **REQ-DBE-017** `fn::text::trimmed_length` and `trimmedTextLength` agree on U+FEFF and U+0085, which `string::trim` keeps and strips while JavaScript's `trim()` strips and keeps them. (`story-shape`) [D53]

## Engine gotchas: queries and indexes

- **REQ-DBE-018** An element index over record links (`themeRefs.*`) makes `CONTAINS` return no rows, while over strings it works: hence `story.themeIds`. (`engine-gotchas`) [J-2026-11-06b-DB]
- **REQ-DBE-019** A query inside a closure (`$list.filter(|$x| …)`, `.map(|$t| …)`) iterates the whole table, never an index: `/v1/themes` sends its probes as top-level statements, and related stories use one `CONTAINSANY` scan. (`engine-gotchas`) [J-2026-11-06b-DB]
- **REQ-DBE-020** The public lists page on one field and a range. (The `OR`: `engine-gotchas`; the `ORDER BY`: the local scale test) [J-2026-11-06b-DB]
  Why: an `ORDER BY` on two fields sorts every matching row, and an `OR` in a cursor starts the index scan at the top.
- **REQ-DBE-021** An `IF` block answers a one-row array as the row itself, so the code wraps it in `array::flatten([…])`. (`engine-gotchas`) [J-2026-11-06b-DB]
- **REQ-DBE-022** A correlated subquery uses `array::last(… ORDER BY … ASC)` or `array::min`, never `ORDER BY … LIMIT 1`, which returned wrong rows on the in-memory engine (a minimal case gives the right rows on RocksDB). [J-2026-11-06b-DB]
- **REQ-DBE-023** Left to itself the planner may pick the wrong index, so `storyStatusLog.publishedAt` names `WITH INDEX storyStatusLog_story`, and a plan is checked with `EXPLAIN` on a local database before it is trusted. [J-2026-11-06b-DB]
- **REQ-DBE-024** Re-defining a full-text index over rows can make the COMMIT fail with a retryable conflict, so the migration runner retries such a step. [D14]

## Engine gotchas: transactions and scripts

`migration` pins each of these.

- **REQ-DBE-025** A `RETURN` inside a transaction commits it early and skips the rest, wherever it hides (`[RETURN 1]`, `1 + RETURN 1`, `IF … THEN RETURN … END`, blocks); inside a function, event, field or param body it doesn't affect the caller. [D14]
- **REQ-DBE-026** `BREAK` and `CONTINUE` in an `IF` or `FOR` block skip the rest of that block while the transaction commits. [D14]
- **REQ-DBE-027** So data scripts follow an allow-list and may not contain `RETURN`, `BREAK` or `CONTINUE`, and schema files are DDL only. [D14]
- **REQ-DBE-028** Every migration step ends with its marker, is count-checked, and counts as rolled back only when the server refused its `COMMIT`. [D14]
- **REQ-DBE-029** Bundled files contain no control or separator characters and only ASCII outside strings. [D14]
  Why: comments end at U+0085, U+2028 and U+2029 too.
- **REQ-DBE-030** The runner refuses `/'/` (a regex literal) and the prefixed strings `r""`, `u''`, `d''`, `b""`, `s''`, and each step ends with a nonce it must get back. [D14]
- **REQ-DBE-031** A bare record path (`table:id.field`) in an `IF` fails ("Specify a database to use"), so it is `LET` first; `FOR $x IN (SELECT …)` fails, so the rows are `LET` and then looped. `SLEEP` needs root. [D14]
- **REQ-DBE-032** The runner uses `/rpc`, never a startup `--import-file` (with `OPTION IMPORT` it hangs the server, and a failing statement is only logged) or `surreal import` (it requires `OPTION IMPORT`, which switches off events and field `VALUE`/`ASSERT`). [D14]
- **REQ-DBE-033** `runQuery` reads `.responses()` for a failed transaction's root cause, since surrealdb.js 2.0.x's `collect()` throws "not executed due to a failed transaction", not the `THROW`. [D14]

## Per-request person sessions

api-user keeps one long-lived WebSocket connection per instance, signed in as `service:api_user`, and
opens a session per request (`withPersonSession` in `libs/database`, used by `PersonSessions` in
`libs/auth`): `newSession()`, `authenticate(clerkToken)`, the work, then `invalidate()` and
`closeSession()` in a `finally`.

- **REQ-DBE-034** A shared session or the connection is never authenticated as a person. [D27]
  Why: requests interleave, and A's query runs as B.
- **REQ-DBE-035** A person session uses `newSession()`, never `forkSession()`: a fork inherits the service login and keeps running as `service:api_user` if the person's token is rejected, while a rejected token on a new session can run nothing. (`request-sessions`) [D27]
- **REQ-DBE-036** A session is closed with `invalidate()` before `closeSession()`, since 2.0.8 otherwise keeps its renewal timer, which later emits `error` on the connection. [D27]
- **REQ-DBE-037** Quick work uses the person's token while it lasts 10 s more; slow work (Bunny, the data download) always opens on a fresh 6-minute pass api-user gets from Clerk for the same session (`PersonSessions.run(…, 'slow')`) and stops retrying after 2 minutes. [DEC-T]
  Why: surrealdb.js 2.0.8 ends a person's session at their token's `exp`, even mid-query.
- **REQ-DBE-038** Service sign-in uses record access (`access: 'svc'`, `serviceSignIn`), so the SDK signs in again after reconnects and the 15-minute token expiry. [D13]

One socket handles an instance's concurrency (requests are multiplexed); a session costs 4 extra
round trips, about 2 ms locally.

## Clerk side

- **REQ-DBE-039** OpenTofu pins Clerk's RS256 public key (`clerk_jwt_public_key` in `infra/terraform/live/dev/cluster/clerk.auto.tfvars`), with no JWKS URL; empty, the migration removes `DEFINE ACCESS clerk`, so no token opens a person session. [D27]
  Why: GKE has no egress.
- **REQ-DBE-040** The default Clerk session token carries `ns` `heisreal`, `db` `main`, `ac` `clerk`, `role`, `email` and `email_verified` (`infra/clerk/dev.json`), so one token serves api-user's guard and SurrealDB. [D27]
- **REQ-DBE-041** The token's `email` (only when `email_verified`) names who added a staff member, and api-admin and api-user count a Moderator or Admin `role` only with a verified `@heisreal.today` email; nothing else is authorized by it. [S-5]
- **REQ-DBE-042** api-user and api-admin verify the token (signature, `exp`/`nbf`/`iat`, `iss`, `azp`, role) before it reaches SurrealDB, which checks neither `iss` nor `azp`, so dev and prod keys must differ. [D27]
- **REQ-DBE-043** SurrealDB rejects a token that is expired, signed with a wrong key, HS256 with the public key or tampered, has `ac` `svc` or unknown, an unknown `sub`, another database or no `exp`, or names an erased person; an `id` claim can't override `AUTHENTICATE`. (`person-session`) [D27]

Key rotation: `infra/clerk/README.md`.
