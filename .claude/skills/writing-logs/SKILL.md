---
name: writing-logs
description: >
  How we write logs in this monorepo: one wide event per request or job, stable field names, and
  the data-handling class of every field (plain, keyed hash, content: hashed unless a debug window
  is open or the work failed, never). Use whenever you add or change logging, error handling, a
  NestJS controller, interceptor, guard or filter, a Next.js route, server action or error page, a
  Pub/Sub job or worker step, or a call to SurrealDB, Clerk, Bunny, Stripe or Resend, and when you
  read logs to debug something.
  Triggers: log, logger, console.log, writeLog, createLog, JsonLogger, error, exception, stack trace,
  trace id, reference, request id, timing, Axiom, Cloud Logging.
---

# Writing logs

Based on [loggingsucks.com](https://loggingsucks.com/) (Boris Tane) and Joel's logging decisions
in `../project/context/research/logging.html` (LG-1 to LG-8). Where a rule below says **pending
Joel**, don't invent an answer: follow the safer reading given, and ask.

## The idea in one line

Log **what happened to this request**, not what your code is doing. One rich, structured event
per request (or job) per service, built up while the work runs and written **once** at the end,
success or failure. Stripe calls it a canonical log line; the blog calls it a wide event.

## Rules

1. **One wide event per unit of work.** A request to a service, a Pub/Sub job, a worker job, a
   scheduled run. Start it at the edge (NestJS middleware, Next.js `proxy.ts`, the job handler),
   pass it down, add fields as you learn things, emit it once when the work ends (response closed,
   job `finally`). Lines inside a request or job are folded into its event (LG-2 C, Joel 22 Nov). Only three kinds of line stay on their own:
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
7. **One id end to end.** Every event carries `ref`: the request's UUID v7 (LG-1b A), made by the
   browser before it sends (or by the first service if no browser sent one), travelling as the W3C
   `traceparent` trace id (the same 128 bits without dashes), shown to people as their error
   "Reference". How it crosses services is **pending Joel (LG-4, recommended:** also write it as
   `logging.googleapis.com/trace` so Google groups our line with Cloud Run's own request line, and
   carry it to jobs as a Pub/Sub attribute**)**.
8. **Sampling: pending Joel (LG-6, recommended:** no sampling, keep everything for 30 days**).** The
   blog's tail sampling (keep all errors and slow requests, a few % of the rest) only matters at
   volumes far above ours. Until LG-6 is answered, don't add sampling.
9. **A failed log send must never fail, slow or change the request.** Write to stdout first; send to
   Axiom after the response, without awaiting it on the request path; swallow and count send
   errors. Logging code never throws into business code.
10. **Server errors are logged by servers only (LG-1c, Joel 22 Nov).** The browser never sends
    details of a server-side error: anyone can read their own network traffic. Only a crash in
    our JavaScript sends a small `error_report` (reference, route, kind) to api-user. Whether a
    request that got no answer (offline, timeout) also sends one is pending Joel (LG-1c).
11. **Same format everywhere.** One JSON object per line on stdout (`libs/logging`): locally, in CI
    and on Google Cloud. Don't add a "pretty" mode to services; pretty-print with `jq` when reading.

## Field names

- `severity`, `message`, `timestamp` first (Cloud Logging's names; `libs/logging` writes them).
  `message` is a short human summary of the event: `POST /stories/:id/submit 200 in 412 ms`.
- Then `event` (`request` | `job` | `startup` | `health` | `error_report`), `ref`, the trace field.
- Group by area as nested objects: `service`, `http`, `user`, `client`, `story`, `upload`,
  `consent`, `moderation`, `db`, `external`, `rate_limit`, `cache`, `error`, `job`.
- `snake_case`; units as suffixes (`_ms`, `_bytes`, `_count`); booleans read as yes/no
  (`cache.hit`); enums are lowercase words (`outcome: "input_refused"`).
- A keyed hash goes in a field ending `_hash`, never under the plain name (`story.body_hash`, not
  `story.body`), so a reader always knows which they are looking at.
- Don't rename a field once it ships: queries, saved views and agents depend on it. Add a new one.
- The full field list with examples is in LG-2 of the logging decision doc; keep code and that list
  in step.

## What may go in a field (data classes)

Joel decided (22–23 Nov 2026) which personal data we log and how. Until the logging build lands
(wide-event helper, hashing key, debug switch), the `libs/logging` README rule still holds for
today's lines: no personal data, tokens, keys or story content.

| Class          | How it is written                                                                                                                                              | Fields                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plain**      | as is, in Axiom and Google alike                                                                                                                               | routes, status, timings, counts, outcomes, ids (`user.id`, `story.id`, job ids), roles, consent version numbers, search queries and tags, and personal fields: `user.email`, `client.ip`, browser (`client.user_agent`), `story.title` (Joel, 23 Nov: plain for simplicity; the privacy wording is expanded to say so, LG-2f). No hashing or encryption for these.        |
| **Keyed hash** | HMAC-SHA-256 with a key from Secret Manager (`libs/secrets`), never plain SHA, `hk1:` prefix. **Always**: on success, on error and inside a debug window alike | sensitive fields that must be matchable (Joel, 23 Nov, LG-2d C): `user.session_hash` = HMAC of Clerk's stable session id (`sid`, the same for the whole visit), to follow journeys; `user.token_hash` = HMAC of the whole Clerk token, to answer "was this exact token used?" (it changes about every minute, so it can't follow journeys). Never the raw token or `sid`. |
| **Content**    | keyed hash plus length by default; plain inside a debug window; **in full whenever the request or job ends in an error**, even outside a window                | long, many-paragraph, non-sensitive fields: story text, descriptions, captions, transcripts, request bodies (with any secret inside a body removed first). **Pending Joel (LG-2e):** where the debug switch lives, its limits and any per-field size cap (16 KB recommended). Until the switch exists, there is no window: hash on success.                               |
| **Never**      | not at all, not on error, not in a debug window                                                                                                                | session tokens, cookies, API keys, passwords, secrets, signed URLs, auth headers, card data, whole header sets.                                                                                                                                                                                                                                                           |

**Sensitive fields are never plain (Joel, 23 Nov).** Only the session id and the token are logged,
as keyed hashes (`user.session_hash`, `user.token_hash`). Cookies, API keys, passwords and auth
headers are not logged at all, hashed or not: the session hash is enough to follow a visit. Never plain, **not when the request fails and not in a debug window**: the
content rule below is not an option for them. Strip them out of a request body before it is logged.

**The content rule (Joel, 23 Nov).** Write content fields through one helper, never by hand:
hashed by default, plain while a debug window is open, and **the full value whenever the work ends
in an error** (`outcome: "error"`: something failed on our side), so the failure can be reproduced.
The default hashing exists **only to keep log volume down** for long, many-paragraph fields such as
story text and transcripts. It is not a privacy measure: only the session id and token are keyed-hashed, other secrets are
left out entirely (rule above), and short personal fields (email, IP, title) are simply plain.
An input refusal (`input_refused`) or a rate limit is not an error: it logs the failed field, its
size and the failed check, never the value. An event holding content in plain sets
`debug: { plain_content: true, reason: "error" | "window" }`.

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
event.content('story.body', dto.body); // decided when the event is written, see below
const res = await event.timeDb('fn::submit_story', () =>
  this.db.query('fn::submit_story($id)', { id }),
);
event.set({ outcome: 'ok' });
```

Content is resolved once, when the event is written, because only then is the outcome known:

```ts
// libs/logging (sketch). Two helpers, two different rules.

// Sensitive (session id, token): always hashed. No `failed`, no `window`: nothing makes it plain.
function sensitiveField(value: string) {
  return hmac(value);
}

// Long non-sensitive content: hashed only to keep log volume down.
function contentField(
  value: string,
  { failed, window }: { failed: boolean; window: boolean },
) {
  if (failed || window) return { value, length: value.length }; // full text on error or in a window
  return { hash: hmac(value), length: value.length }; // default: fingerprint only
}

// A request body is content, but secrets inside it are removed first, even on error.
const body = contentField(JSON.stringify(withoutSecrets(req.body)), {
  failed,
  window,
});
// finish(): outcome === 'error' → story.body (full) + debug.reason "error";
// debug window open → story.body (plain) + debug.reason "window";
// otherwise → story.body_hash + story.body_length.
// user.session_hash = sensitiveField(sid) and user.token_hash = sensitiveField(token), always.
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
//   filter       event.fail(err): outcome ('refused' or 'error'), error.type/code/retriable;
//                an unexpected error also writes the immediate error line here
```

## Reading logs

- **Axiom** (LG-3: free plan, US, Joel's account) holds the wide events; agents use Axiom's MCP.
  Search by `ref`, `user.id`, `story.id`, `action`, `outcome`. What stats we keep and where is
  **pending Joel (LG-8)**; meanwhile group by route/outcome and never list people in a stat.
- **Google Cloud Logging, London, 30 days** holds the same lines plus Cloud Run's own request line
  (status, latency, IP, browser): `gcloud logging read 'jsonPayload.ref="<ref>"' --project
heisreal-dev --freshness=1d --format=json`, then `trace="projects/heisreal-dev/traces/<ref
without dashes>"` for Cloud Run's line (once the LG-4 trace field is in).
- A reference with no lines means the request never reached us; its UUID v7 still tells you the
  millisecond it was made. Browser crashes send an `error_report` event
  with the reference (requests that got no answer: pending Joel, LG-1c). A server-page crash is found by its time and route.

## Before you finish

- One event per request/job; no new `console.*` or mid-request log lines.
- Every new field has a stable name and a data class from the table; nothing from "Never".
- Outside calls timed; errors as fields; `ref` present.
- Log sending can't throw or block.
