# SurrealDB notes

How SurrealDB 3.2.4 and surrealdb.js 2.0.8 behave where it shapes our schema and queries. Most of these
traps are also explained in a comment at the place they bite; this file lists the ones with no single
place, and the background a comment points to.

When the engine or the SDK is upgraded, re-check by hand every note below that names no pinning test:
they could change without anything failing. A note's test, in brackets, is in `integration/`
(`engine-gotchas.int-spec.ts` pins them on scratch tables, so a failure there names the note that changed).

## Permissions and sessions

- A write the permissions deny returns an empty result, not an error, and a field write outside its field
  rule (field `PERMISSIONS` or `VALUE`) is dropped silently: check what was stored. A `READONLY` change and
  an event's `THROW` are errors. An allowed write on a table the caller can't read back also returns
  empty. (`write-scope`, `service-permissions`; `WriteNotAppliedError` in `src/lib/query.ts`,
  `schema/schema-04-stories.surql` head)
- In a `service` session `$auth.id` is NONE (the `service` table is `PERMISSIONS NONE`), and
  `SELECT count() … GROUP ALL` with no WHERE skips a row rule that reads `$auth.id`. So the schema's rules,
  and every query a service session runs, compare `$auth` itself (`submitter = $auth`,
  `$auth IN [service:…]`). Queries that only ever run in a person's session may use `$auth.id`
  (`apps/api-user/src/app/favourites/favourites.controller.ts`,
  `libs/story-cards/src/lib/story-summary.ts`). (`engine-gotchas`, `public-view`)
- A function runs with the caller's permissions in queries and permission clauses, so it sees nothing the
  caller can't (fail closed), but elevated inside events. (`engine-gotchas`; `schema/schema-01-system.surql`,
  `_setting`)
- Row and field rules can follow links both ways without recursing: the story's rule reads
  `currentStatus.status`, the status entry's rule reads `story.currentStatus`.
  (`public-view`; `schema/schema-04-stories.surql`)
- System users (the migrator, dev-seed, the tests) bypass permissions, but every event still runs.

## Fields and values

- A field `VALUE` also runs for a nested `SET` (`SET a.b = …`), with `$value` the whole new field and
  `$before` the old one. (`engine-gotchas`)
- Inside a subquery, `$parent` is the outer query's record: a computed field uses its own record's fields
  directly, never `$parent`. (The services' queries use `$parent` in a subquery as intended, e.g.
  `apps/api-user/src/app/stories/story-store.ts`.) (`engine-gotchas`)
- `array<object>` items store keys the schema doesn't define (nested objects refuse them), and
  `REMOVE FIELD` keeps the stored values: check such items' keys explicitly in the schema, and clean up a
  removed field's stored values separately. (`engine-gotchas`)

## Queries and indexes

- An element index over record links (`themeRefs.*`) makes `CONTAINS` return no rows; over strings it
  works: hence `story.themeIds`. (`engine-gotchas`; `schema/schema-04-stories.surql`,
  `libs/story-filters`)
- A correlated subquery with `ORDER BY … LIMIT 1` returned wrong rows on the in-memory engine (a minimal
  case gives the right rows on RocksDB): use `array::last(… ORDER BY … ASC)` or `array::min`.
  (`apps/api-user/src/app/stories/story-store.ts`, `schema/schema-04-stories.surql`
  `storyStatusLog.publishedAt`)
- Left to itself the planner may pick the wrong index, so queries on a story's status entries name
  `WITH INDEX storyStatusLog_story` (`schema/schema-04-stories.surql`). Check a query's plan with `EXPLAIN`
  on a local database before trusting it.

## Transactions and scripts

- A `RETURN` statement in a transaction, at the top level or nested in control flow (`IF`, blocks),
  commits it early and skips the rest; `BREAK` and `CONTINUE` skip the rest of their block. So a
  command's statements contain no such `RETURN`, `BEGIN` or `COMMIT` (`src/lib/idempotency.ts`), and data
  scripts may not use them (`schema/migrate.py`). A `RETURN` inside a function, event or field
  definition body, and a statement's `RETURN` clause (`CREATE … RETURN id`), are fine. (`migration`)
- In a data script, a bare record path (`table:id.field`) in an `IF` fails ("Specify a database to use"):
  `LET` it first. `FOR $x IN (SELECT …)` fails: `LET` the rows, then loop over them. `SLEEP` needs root, so
  the runner refuses it (`schema/migrate.py`, `REFUSED_WORDS`).
- In a failed transaction, surrealdb.js 2.0.x's `collect()` throws "not executed due to a failed
  transaction", not the `THROW`: `runQuery` reads `.responses()` for the root cause (`src/lib/query.ts`).

## surrealdb.js connections

- api-user keeps one WebSocket connection per running copy and multiplexes its requests over it; each
  request's person session (`src/lib/person-session.ts`) costs 4 extra round trips, about 2 ms locally.
  surrealdb.js 2.1.1 or later's `.as(token)` over HTTP would be a stateless alternative for simple reads,
  but has no interactive transactions. (`request-sessions`)
