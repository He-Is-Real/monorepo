---
name: writing-logs
description: >
  How we write logs in this monorepo: one wide event per request or job, stable field names, and
  the data-handling class of every field (plain, keyed hash, long text: hashed unless the work
  ends in an error, a refusal or a rate limit, never), and search events that never say who searched. Use whenever you add or change logging, error handling, a
  NestJS controller, interceptor, guard or filter, a Next.js route, server action or error page, a
  Pub/Sub job or worker step, or a call to SurrealDB, Clerk, Bunny, Stripe or Resend, and when you
  read logs to debug something.
  Triggers: log, logger, console.log, writeLog, createLog, JsonLogger, error, exception, stack trace,
  trace id, reference, request id, timing, Axiom, Cloud Logging.
---

# Writing logs

Based on [loggingsucks.com](https://loggingsucks.com/) (Boris Tane) and Joel's logging decisions
in `../project/context/research/logging.html` (LG-1 to LG-10, LG-12). Every point is decided; if something new comes up that the rules below don't
cover, don't invent an answer: ask Joel.

## The idea in one line

Log **what happened to this request**, not what your code is doing. One rich, structured event
per request (or job) per service, built up while the work runs and written **once** at the end,
success or failure. Stripe calls it a canonical log line; the blog calls it a wide event.

## Rules

1. **One wide event per unit of work.** A request to a service, a Pub/Sub job, a worker job, a
   scheduled run. Start it at the edge (NestJS middleware, Next.js `proxy.ts`, the job handler),
   pass it down, add fields as you learn things, emit it once when the work ends (response closed,
   job `finally`). Lines inside a request or job are folded into its event (LG-2 C, Joel 22 Nov). A search also writes its own small `event: "search"`
   beside the request's wide event (LG-2g A, below). Otherwise only three kinds of line stay on their own:
   start-up/settings, background work outside any request (health checks, queue state), and the
   **immediate** unexpected-error line with `stack_trace` (Error Reporting groups errors from it).
2. **No breadcrumbs.** No `console.log`, no "got here", no "calling Bunny…" then "Bunny answered".
   If a fact helps debugging, it is a field on the event. Use `libs/logging`, never `console.*`.
3. **Wide and specific.** Many fields (dimensionality) and fields with many values such as
   `user.id`, `story.id`, `ref` (cardinality). Those are what let you filter to one person or one
   story. Never put them in a metric label (metrics stay low-variety: route, outcome).
4. **Business context, not just HTTP.** Say what the person was doing: `action: "story.submit"`,
   the story's id and type, the consent versions the request carried, the moderation decision,
   the upload's size. That is what turns logs into answers and stats (LG-8).
5. **Time every outside call.** Each SurrealDB query/function and each Clerk, Bunny, Stripe or
   Resend call adds to `db` / `external.<name>`: call count, total ms, slowest, status.
6. **Errors are fields.** `outcome: "error"` and `error: { type, code, retriable }` on the event.
   Messages never quote what someone sent; database errors are reduced to their kind.
7. **One id end to end (LG-4 A, Joel 24 Nov).** Every event carries `ref` (except search events,
   below): the request's UUID v7 (LG-1b A), made by the browser before it sends (or by the first
   service if no browser sent one), travelling as the W3C `traceparent` trace id (the same 128 bits
   without dashes), shown to people as their error "Reference". One trace id goes browser → website
   and APIs → Pub/Sub job (as a message attribute) → the worker's `event: "job"`, which the worker
   writes to Cloud Logging. Each service also writes it as `logging.googleapis.com/trace` so Google
   groups our line with Cloud Run's own request line. Timings go in the wide event (`db`,
   `external`). **No tracing library**: no OpenTelemetry SDK or spans.
8. **No sampling (LG-6 A, Joel 24 Nov).** Every event is kept, for 30 days. Don't add sampling
   ("for now, but we may revisit sampling at larger scale").
9. **A failed log send must never fail, slow or change the request.** Write to stdout first; the
   library queues the same entry for Axiom and sends it in the background, never awaited on the
   request path; send errors are swallowed and counted. Logging code never throws into business
   code.
10. **Server errors are logged by servers only (LG-1c, Joel 22 Nov).** The browser never sends
    details of a server-side error: anyone can read their own network traffic. Only failures the
    servers can't see send a small `error_report` (reference, route, kind) to api-user: a crash in
    our JavaScript (`kind: "browser_crash"`), and a request that got no answer (offline, timeout;
    `kind: "no_answer"`, Joel 24 Nov, LG-9a A), sent once the page can reach us again. Held in
    memory only, never the browser's storage; if the page closes first, nothing is sent.
11. **Deployment details on every entry (LG-10, Joel 24 Nov).** Every line carries the `service`
    group: `name`, `version` (the git commit the image was built from), `revision`, `env`, and on
    Cloud Run `region` and `instance`. `libs/logging` adds it; never write these by hand, and never
    let reading them delay start-up or a request.
12. **Same format everywhere.** One JSON object per line on stdout (`libs/logging`): locally, in CI
    and on Google Cloud. Don't add a "pretty" mode to services; pretty-print with `jq` when reading.

## Field names

- `severity`, `message`, `timestamp` first (Cloud Logging's names; `libs/logging` writes them).
  `message` is a short human summary of the event: `POST /stories/:id/submit 200 in 412 ms`.
- Then `event` (`request` | `job` | `search` | `startup` | `health` | `error_report`), `ref`, the
  trace field (neither on `search`).
- Group by area as nested objects: `service` (on every entry, rule 11), `process`, `http`, `user`,
  `client`, `story`, `upload`, `consent`, `moderation`, `db`, `external`, `rate_limit`, `cache`,
  `error`, `job`.
- Cold starts and memory-cache reads (LG-12, Joel 24 Nov: "add both"; plain, nothing about a person):

  | Field                | Example | What                                                                                |
  | -------------------- | ------- | ----------------------------------------------------------------------------------- |
  | `process.cold_start` | `true`  | the first request or job event this running copy writes; `false` on every later one |
  | `process.uptime_ms`  | `812`   | how long the process had been up when this request or job started                   |
  | `cache.hit`          | `true`  | api-public-read: answered from its memory cache (fresh, or the stale copy below)    |
  | `cache.stale`        | `false` | the copy kept for a database restart was served because the database was away       |
  | `cache.age_ms`       | `4000`  | how old the answer from memory was (only when `cache.hit`)                          |
  | `cache.not_modified` | `true`  | the browser already had it: a `304` (left off when no cacheable answer was sent)    |

  `libs/logging` writes `process.*` on every request and job event (never on search events);
  `PublicCacheInterceptor` writes `cache.*`. Never write them by hand.

- Deployment details (`service`, LG-10; plain; `libs/logging` writes them):

  | Field              | Example              | What                                                                      |
  | ------------------ | -------------------- | ------------------------------------------------------------------------- |
  | `service.name`     | `api-user`           | the service or job                                                        |
  | `service.version`  | `1fb357f4c0de`       | the git commit the image was built from (`snapshot-<sha>`, `dev` locally) |
  | `service.revision` | `api-user-00042-xyz` | Cloud Run's revision, or the job's execution                              |
  | `service.env`      | `dev`                | `dev`, `prod` or `local`                                                  |
  | `service.region`   | `europe-west2`       | Cloud Run only, once Google's metadata server answers                     |
  | `service.instance` | `0069c7a2…`          | Cloud Run's instance id, the same way                                     |

- `snake_case`; units as suffixes (`_ms`, `_bytes`, `_count`); booleans read as yes/no
  (`cache.hit`); enums are lowercase words (`outcome: "input_refused"`).
- A keyed hash goes in a field ending `_hash`, never under the plain name (`story.body_hash`, not
  `story.body`), so a reader always knows which they are looking at.
- Don't rename a field once it ships: queries, saved views and agents depend on it. Add a new one.
- The full field list with examples is in LG-2 of the logging decision doc; keep code and that list
  in step.

## What may go in a field (data classes)

Joel decided (22–23 Nov 2026) which personal data we log and how. Until the logging build lands
(wide-event helper, hashing keys), the `libs/logging` README rule still holds for
today's lines: no personal data, tokens, keys or story content.

| Class                             | How it is written                                                                                                                                                              | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plain**                         | as is, in Axiom and Google alike                                                                                                                                               | routes, status, timings, counts, outcomes, ids (`user.id`, `story.id`, job ids), roles, consent version numbers, search queries, tags and filters, and personal fields: `user.email`, `client.ip`, `story.title` (Joel, 23 Nov: plain for simplicity; the privacy wording is expanded to say so, LG-2f). No hashing or encryption for these, **except on search events**, where `user.email`, `client.ip` and `user.id` are keyed hashes (see "Search events"). The browser's user agent `client.user_agent` is plain everywhere, search events included: we need it to tell whether anyone is running bots on the site (Joel, 23 Nov), and the privacy notice says so. |
| **Keyed hash**                    | HMAC-SHA-256 with a key from Secret Manager (`libs/secrets`), never plain SHA, `hk1:` prefix (search events: their own key, `hs1:`). **Always**: on success and on error alike | sensitive fields that must be matchable (Joel, 23 Nov, LG-2d C): `user.session_hash` = HMAC of Clerk's stable session id (`sid`, the same for the whole visit), to follow journeys; `user.token_hash` = HMAC of the whole Clerk token, to answer "was this exact token used?" (it changes about every minute, so it can't follow journeys). Never the raw token or `sid`. On search events, who searched (see "Search events").                                                                                                                                                                                                                                         |
| **Long text (hash unless error)** | keyed hash plus length by default; **in full whenever the request or job ends in an error, an input refusal or a rate limit**                                                  | long, many-paragraph, non-sensitive fields: story text, descriptions, captions, transcripts, request bodies (with any secret inside a body removed first). There is no debug window or switch (Joel, 23 Nov, LG-2e): if we ever really need the plain words of a field, we change the code to stop hashing it, in a normal PR.                                                                                                                                                                                                                                                                                                                                          |
| **Never**                         | not at all, not on error                                                                                                                                                       | session tokens, cookies, API keys, passwords, secrets, signed URLs, auth headers, card data, whole header sets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Sensitive fields are never plain (Joel, 23 Nov).** Only the session id and the token are logged,
as keyed hashes (`user.session_hash`, `user.token_hash`). Cookies, API keys, passwords and auth
headers are not logged at all, hashed or not: the session hash is enough to follow a visit. Never plain, **not even when the request fails**: the
long text rule below is not an option for them. Strip them out of a request body before it is logged.

**The long text rule (Joel, 23 Nov; widened 24 Nov, LG-9b B).** Long text: hashed unless the
request ends in an error, a refusal or a rate limit. Write long text fields through one helper,
never by hand: hashed by default, and **the full value whenever the work ends in an error, an input
refusal or a rate limit** (`outcome: "error"`, `"input_refused"` or `"rate_limited"`), so a failure
can be reproduced and we see what the person was trying to do (Joel: "I want to see what users
were attempting in detail when they hit a rate limit").
The default hashing exists **only to keep log volume down** for long, many-paragraph fields such as
story text and transcripts. It is not a privacy measure: the session id and token are keyed-hashed, other secrets are
left out entirely (rule above), and short personal fields (email, IP, title) are simply plain
(except who searched, on search events: below).
An input refusal also logs the failed fields and checks (`input.failed_fields`,
`input.failed_checks`). **Not found** (`not_found`) and **restarting** (`restarting`) keep long text
hashed. An event holding long text in plain sets `debug: { plain_content: true }` (only ever on an
error, an input refusal or a rate limit). Sensitive fields and who searched stay hashed or left out
in every case.

**Search events (Joel, 23 Nov; LG-2g A, 24 Nov):** "for privacy, only for search terms and filters always hash the
ip, email, user id anything that links search terms to a specific user. The terms themselves in
plain text are essential for us to build the site but we dont need to know who is searching for
them."

- A search is **its own event**, `event: "search"`, written alongside the route's normal wide
  event and not joined to it: **no `ref`, no trace field, no `user.session_hash` or
  `user.token_hash`**. It holds the terms, filters, result count, timing and outcome (plain) and who
  searched (hashed, below).
- The route's normal wide event **never carries the terms**: no `search.q`, `search.tags` or
  `search.filters` on it. An error during a search is recorded there as usual (with its `ref`),
  without the words.
- Cloud Run's own request lines for search addresses (`q=` or tag filters, which hold the terms next
  to a plain IP) are dropped from the London bucket by a Cloud Logging exclusion in OpenTofu.
- Every field that ties the search to one person is a keyed hash, under its `_hash` name with the
  plain name left off: `client.ip_hash`, `user.email_hash`, `user.id_hash`. **Never plain, not even
  on error.** `user.role`, `client.user_agent` and `client.browser / os / device` stay plain;
  `user.account_age_days` is left off.
- These hashes use **their own HMAC key** (Secret Manager secret `log-search-hmac`, `hs1:` prefix),
  never used for any other field, so a search can't be matched to the same person's other events by
  accident or by joining fields. Holding that key, someone could still hash a known email on purpose
  and find that person's searches; don't build tooling that does.

Stack traces are fine (Joel: they help us find abuse); make sure no error message you write
embeds a value from the request.

## Good and bad (NestJS)

```ts
// Bad: scattered sentences, a value from the request in a message, no timing, no id.
this.logger.log(`Submitting story ${dto.title} for ${user.email}`);
const res = await this.db.query('fn::submit_story($id)', { id });
this.logger.log('Story submitted');

// Good: the request's event (started by the shared middleware) gains facts as they happen.
event.set({
  action: 'story.submit',
  story: { id, type: dto.type, title: dto.title },
});
event.longText('story.body', dto.body); // decided when the event is written, see below
const res = await event.timeDb('fn::submit_story', () =>
  this.db.query('fn::submit_story($id)', { id }),
);
event.set({ outcome: 'ok' });
```

Long text is resolved once, when the event is written, because only then is the outcome known:

```ts
// libs/logging (sketch). Two helpers, two different rules.

// Sensitive (session id, token): always hashed with the general key (hk1:). No `failed`:
// nothing makes it plain.
function sensitiveField(value: string) {
  return hmac(value); // general log key, prefix hk1:
}

// Who searched (ip, email, user id on a search event): always hashed with the search-only key (hs1:),
// never the general key, so these hashes can't be joined to the rest of the logs.
function searchIdentityField(value: string) {
  return searchHmac(value); // key `log-search-hmac`, prefix hs1:
}

// Long non-sensitive text: hashed only to keep log volume down.
function longTextField(value: string, { plain }: { plain: boolean }) {
  if (plain) return { value, length: value.length }; // full text on error, input refusal or rate limit
  return { hash: hmac(value), length: value.length }; // default: fingerprint only
}

// A request body is long text, but secrets inside it are removed first, even when plain.
const plain = ['error', 'input_refused', 'rate_limited'].includes(outcome);
const body = longTextField(JSON.stringify(withoutSecrets(req.body)), { plain });
// finish(): plain → story.body (full) + debug.plain_content true;
// otherwise (ok, not_found, restarting) → story.body_hash + story.body_length.
// user.session_hash = sensitiveField(sid) and user.token_hash = sensitiveField(token), on every
// event except search events.
// On a search event: client.ip_hash / user.email_hash / user.id_hash = searchIdentityField(...);
// no ref, no session_hash or token_hash.
```

Where the event starts and ends (sketch; the `libs/logging` helper is part of the logging build
and may not exist yet). NestJS runs middleware, then guards, then interceptors, so the event
must start in **middleware**: a guard refusal never reaches an interceptor, and an
interceptor-only event would miss it.

```ts
// Middleware: runs first. Start the event; write it once when the response is done.
use(req: Request, res: Response, next: NextFunction) {
  req.event = startEvent(req); // ref from traceparent, service, http.method
  res.on('close', () => req.event.finish(res.statusCode)); // also on aborted requests; never throws
  next();
}
// Guards, interceptors and the exception filter only add to req.event:
//   guard        event.set({ user: { id, role } }); a refusal throws, and the filter records it
//   interceptor  event.set({ http: { route } }) from the handler's route
//   filter       event.fail(err): outcome ('input_refused', 'rate_limited', 'not_found', 'restarting' or 'error'), error.type/code/retriable;
//                an unexpected error also writes the immediate error line here
```

## Reading logs

- **Read in Axiom by default (LG-5, Joel 24 Nov).** Axiom (LG-3: free plan, Joel's account, edge
  deployment EU Central 1, one dataset per environment, `heisreal-dev`) gets every entry stdout
  gets (`libs/logging/src/axiom.ts`); Joel and agents read there first (`docs/logs-runbook.md`).
  Search by `ref`, `user.id`, `story.id`, `action`, `outcome`.
- **Agents read through the Axiom MCP or CLI**, set up per developer machine (never in the repo):
  MCP `queryDataset` (APL), or
  `axiom query "['heisreal-dev'] | where ref == '<reference>'" --start-time -1h -f json`. Dotted
  names need brackets (`['http.route']`); check names with `getDatasetFields` or
  `libs/logging/src/fields.ts`. Read only: never create, change or delete anything in Axiom.
  Examples (by `ref`, failed requests by route, a service's last start-up): `docs/logs-runbook.md`,
  "How agents read logs".
- **Field budget:** Axiom's free plan keeps at most 256 fields per dataset and drops new ones
  beyond that. Every flattened field name we write is listed in `libs/logging/src/fields.ts`; a new
  field goes there too, and its test fails past 200. Prefer an existing field to a new one.
- **Stats are in Axiom only (LG-8, Joel 24 Nov):** Axiom queries and dashboards over the last 30
  days. Nothing in Google for stats (no Log Analytics, BigQuery, log-based metrics or dashboards).
  Stats group by route, service, outcome, action and day, **never by person, story or address**.
- **`gcloud` stays (LG-5)** for Google Cloud Logging, London, 30 days: the same lines plus Cloud
  Run's own request line (status, latency, IP, browser): `gcloud logging read 'jsonPayload.ref="<ref>"' --project
heisreal-dev --freshness=1d --format=json`, then `trace="projects/heisreal-dev/traces/<ref
without dashes>"` for Cloud Run's line (the LG-4 trace field).
- A reference with no lines means the request never reached us; its UUID v7 still tells you the
  millisecond it was made. Browser crashes and requests that got no answer send an
  `error_report` event with the reference (LG-1c, LG-9a; a no-answer report only arrives if the
  page reached us again before it closed). A server-page crash is found by its time and route.

## Before you finish

- One event per request/job; no new `console.*` or mid-request log lines.
- Every new field has a stable name and a data class from the table (Plain, Keyed hash, Long text,
  Never); nothing from "Never".
- Long text goes through the one helper: hashed, in full only on error, input refusal or rate limit.
- Search events: their own `event: "search"`, no `ref` or session/token hash; terms plain, who
  searched only as `hs1:` hashes, never plain; the route's own event has no terms.
- No sampling; no tracing library.
- Outside calls timed; errors as fields; `ref` present (except on search events).
- Log sending can't throw or block.
