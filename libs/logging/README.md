# @heisreal/logging

The one log format every service, job and the media worker writes (Joel, 2026-11-14): one JSON
object per line, everywhere (Google Cloud and a developer's machine).

```json
{
  "severity": "INFO",
  "message": "api-user listening on http://localhost:3002",
  "timestamp": "2026-11-14T12:00:00.000Z",
  "context": "NestApplication"
}
```

- `severity`: Cloud Logging's names, `DEBUG`, `INFO`, `NOTICE`, `WARNING`, `ERROR`, `CRITICAL`.
- `message`, then `timestamp` (ISO 8601, UTC), then context fields (a Nest `context`, a job's
  `step`, counts and ids). An error's stack is in the same entry, `stack_trace`, where Error
  Reporting looks for it.
- `LOG_LEVEL` sets the lowest severity written: `DEBUG`, `INFO` (the default, also for an
  unknown value), `NOTICE`, `WARNING`, `ERROR` or `CRITICAL`, any case. `LOG_LEVEL=DEBUG` adds
  Nest's `debug` and `verbose` lines.
- ERROR and CRITICAL go to stderr, the rest to stdout.

Use:

- `writeLog(severity, message, fields?)` or `createLog({ job: 'x' }).info(...)`: plain code (the
  website's server code, jobs, the media worker). No dependencies.
- `JsonLogger` from `@heisreal/logging/nest`: Nest's `ConsoleLogger` in JSON mode, extended to
  write `severity` and an ISO `timestamp`. The four API services get it through
  `START_UP_OPTIONS` (libs/database); cert-signer passes it to `NestFactory.create`; code that
  isn't a Nest app but uses libraries logging through Nest's `Logger` calls
  `Logger.overrideLogger(new JsonLogger())`. Nest levels: verbose, debug → DEBUG; log → INFO;
  warn → WARNING; error → ERROR; fatal → CRITICAL.

## Wide events (`@heisreal/logging/event`)

One event per request or job (the writing-logs skill, `.claude/skills/writing-logs/SKILL.md`;
decisions LG-1 to LG-9 in `../project/context/research/logging.html`). Node only.

- **Start, add, finish.** `startEvent('request' | 'job', service, trace)`; `runWithEvent(event, work)`
  makes it `currentEvent()` for everything `work` calls; `event.set({ story: { id } })` adds plain
  fields (merged by group); `event.write()` writes it once (later calls do nothing; it never throws).
  The APIs get this from `wideEvents(<service>)` in `@heisreal/http` (added first in `main.ts`):
  started before the rate limiters and guards, written when the response closes.
- **The envelope:** `severity`, `message`, `timestamp`, then `event`, `ref`,
  `logging.googleapis.com/trace` (with `GCP_PROJECT`), `service` (below), then the groups. `outcome`: `ok`, `input_refused`, `not_found`, `rate_limited`, `restarting`, `refused`
  (any other refusal: not signed in, not allowed, a conflict) or `error`. Severity: `error` →
  ERROR; `rate_limited`, `restarting` → WARNING; the rest INFO.
- **Reference / trace id:** `traceFromHeader(traceparent)` or `newTrace()` (a UUID v7); `ref` is the
  id with dashes, the trace field the same 32 hex digits.
  `traceparentFor(traceId)` makes a `traceparent` for a call this work starts; `traceAttributes()`
  is the current event's trace as a Pub/Sub message attribute (`traceparent`), which every
  publisher of `media-jobs` adds. The result writer (apps/workflow) uses `wideEvents('workflow',
'job')`: one `event: "job"` per call from the media worker, with the worker's trace.
- **Job time:** every `event: "job"` carries `job.duration_ms`, the job's whole time from start to
  written (LG-14b A, Joel 25 Nov 2026); `libs/logging` adds it, never by hand.
- **Timings:** `timeDb(name, work)` (libs/database's `runQuery` already does it), `timeExternal(name,
work)` and `timedFetch(name, fetch)` for Clerk, Bunny, Stripe, Resend → `db { calls, total_ms,
slowest { name, ms } }`, `external.<name> { calls, ms, status }`.
- **Facts from shared code:** `note(fields, { severity, message })` puts the fields on the current
  event, or writes one line when there is none (start-up, background work, a job without an event)
  or when it was already written (the caller hung up mid-work): that line carries the request's
  `ref`, trace field and `service`, so a record like an erasure is never lost.
- **Errors:** `event.fail({ type, code, retriable, message })` (our own words); the immediate
  unexpected-error line is `writeErrorLine(err, { ref, traceId, fields })` (`stack_trace`, for Error
  Reporting). `ProblemFilter` (libs/http) does both for the APIs; the website's `onRequestError`
  writes the line with its route and Next's `digest`.
- **Browser error reports** (LG-1c, LG-9a): `writeErrorReport({ reference, route, kind, client })`
  writes `event: "error_report"` with the person's reference as `ref` (api-user's
  `POST /v1/error-reports`); `kind` is `browser_crash` or `no_answer`.

### Data classes (what may go in a field)

| Class                         | How                                                                                                                                         | Helper                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Plain                         | as is: routes, timings, ids, `user.email`, `client.ip`, `story.title`…                                                                      | `event.set`                                    |
| Keyed hash                    | HMAC-SHA-256, `hk1:` + 64 hex, under a `_hash` name, always                                                                                 | `event.sensitive('user.session_hash', sid)`    |
| Long text (hash unless error) | `<field>_hash` + `<field>_length`; in full (and `debug.plain_content: true`) when the outcome is `error`, `input_refused` or `rate_limited` | `event.longText('story.body', text)`           |
| Never                         | not written: tokens, cookies, keys, passwords, auth headers, signatures, session ids, card data                                             | `withoutSecrets(body)` strips them from bodies |

- **Search events** (`writeSearchEvent`, or `searchEvent(req, …)` in libs/http): `event: "search"`,
  no `ref`, no trace field, no session or token hash; terms and filters plain; who searched only as
  `client.ip_hash`, `user.email_hash`, `user.id_hash` with the search-only key (`hs1:`). The
  request's own event never carries `search` (it is removed if set). api-public-read writes it from
  an interceptor around its answer cache, so a search answered from memory is still logged; for
  web's own calls (the website key) it writes none, because web's proxy wrote it with the
  visitor's address.
- **Keys:** `log-hmac` (general, `hk1:`) and `log-search-hmac` (search only, `hs1:`) in Secret
  Manager, named by `LOG_HMAC_SECRET` and `LOG_SEARCH_HMAC_SECRET` and read at start-up through
  `loadLogKeys` by `LogKeysModule` (libs/http) and the website's `instrumentation.ts`. A deployed
  service (`K_SERVICE` set) refuses to start without both. The keys live on `globalThis`, so every
  bundled copy of this library in one process (the website's proxy and instrumentation) uses them.
  Unset locally and in tests: fixed development keys (`DEV_LOG_KEYS`), never a real one, with a
  start-up warning.
- **Size:** Google refuses an entry over 256 KB. An entry over `MAX_ENTRY_BYTES` (200 000) has its
  plain long text cut, longest first (`debug.truncated_fields`; `_length` keeps the full length);
  if still too long, only the envelope, `http`, `action`, `outcome` and `error` are kept
  (`debug.oversized`).
- **Where it goes:** stdout (Cloud Run hands it to Cloud Logging, London), and every entry
  written to stdout (by `writeLog`, `createLog`, `JsonLogger`, events, `note` and error lines)
  also goes to each sink added with `addLogSink`, after the same `LOG_LEVEL` filter. The sinks
  live on `globalThis`, so a server that bundles this library twice (the website) has one set.
  The media worker, off Google Cloud, also sends events to Cloud Logging itself
  (apps/media-worker/src/cloud-logging.ts). A sink that throws, or fails to send, is counted
  (`failedLogWrites()`), never thrown into the request. No sampling.
- **Axiom (`@heisreal/logging/axiom`, LG-3):** `startAxiomLogs({ read })` adds the Axiom sink
  where `AXIOM_DATASET` (`heisreal-dev`; `heisreal-prod` later), `AXIOM_DOMAIN`
  (`eu-central-1.aws.edge.axiom.co`, EU Central 1) and `AXIOM_TOKEN_SECRET` (`axiom-ingest-token`,
  read through `read`, libs/secrets) are set. It queues each entry and sends the queue to
  `POST https://<domain>/v1/ingest/<dataset>?timestamp-field=timestamp` (`Authorization: Bearer`,
  a JSON array, up to 1000 entries or 4 MB each) as soon as the current turn of the event loop
  ends; while a send is in flight, newer entries wait for the next one. A refused or timed-out
  send (10 s) is dropped and counted, with one stdout warning a minute; no retries. None set
  (locally, tests): nothing is sent. Partly set, or the token can't be read or is empty: one
  start-up warning, stdout only; the service still starts. Started by `LogKeysModule`
  (libs/http) in the Nest services, by housekeeping and the media worker in their `main.ts`, and
  by the website's `instrumentation.ts` (`register`, after its log keys).
- **Shutting down:** `flushLogSinks(ms)` sends what every sink holds, waiting at most `ms`. The
  Nest services call it from `LogKeysModule` on SIGTERM (`enableShutdownHooks`); housekeeping
  before it exits; the media worker when it stops. The website doesn't: Next has no shutdown hook
  for App Router apps (its own SIGTERM handler closes the server and exits), so lines still
  queued when an idle website instance is shut down are missing in Axiom (not in Google's copy).
- **Cloud Run's CPU:** our services use request-based billing (`cpu_idle = true`), so CPU is
  throttled once no request is in flight: a send started as a response closes may pause until
  the instance's next request, or until shutdown, when Cloud Run gives the instance CPU for 10 s
  and the flush above sends the rest. An instance killed without SIGTERM loses at most the queued
  lines in Axiom; Google's copy from stdout is complete.
- **Reading:** in Axiom first (`docs/logs-runbook.md`); Google's copy with
  `gcloud logging read 'jsonPayload.ref="<ref>"' --project heisreal-dev --freshness=1d --format=json`.
- **Fields:** Axiom's free plan keeps 256 fields per dataset. `src/fields.ts` lists every
  flattened field name we write; its test fails past 200.

### Tracing (`@heisreal/logging/tracing`, LG-15)

OpenTelemetry core, no automatic tracing (Joel, 25 Nov 2026: "use open telemetry"): each request's
and job's timeline goes to Axiom's `heisreal-traces` dataset beside the logs.

- **Start:** `startTracing({ service, read })`, first in each service's `main.ts` (the website's
  `register`, the media worker and housekeeping after their secrets client). On only where
  `AXIOM_TRACES_DATASET`, `AXIOM_DOMAIN` and `AXIOM_TOKEN_SECRET` (`axiom-ingest-token`, the same
  token as the logs) are set; locally and in tests nothing is recorded or sent. Partly set: one
  start-up warning. The token is read when the first batch is sent, not at start-up, so it never
  adds to a cold start; a token that can't be read is one warning then, and spans are dropped.
  `flushTracing(ms)` sends what is left at shutdown, beside `flushLogSinks` (the website has no
  shutdown hook, as for logs).
- **Spans:** the wide event is the span. `startEvent` opens it (a server span for requests, a
  consumer span for jobs), `write()` ends it with the route pattern as its name (`wideEvents` sets
  `GET /v1/stories/:id`) and the plain low-variety fields as attributes; `timeDb` opens
  `db <query name>` and `timeExternal` / `timedFetch` open `<service> <method>` as children.
  `traceAttributes()` and `event.traceparent()` pass the span on (Pub/Sub, the media worker's
  calls to the result writer). Tracing off: none of this happens and the event is the same.
- **The Reference is the trace id:** new traces get a UUID v7 trace id (`uuidv7TraceIds`), an
  incoming `traceparent` is continued, and `ref` is the span's trace id. Everything is recorded
  and sent with the sampled flag `01` (LG-6 A).
- **Data classes:** every span leaves through `cleanSpan`: only the attributes in
  `SPAN_ATTRIBUTES`, names without addresses, query strings or any path but the span's own route
  pattern (`http.route` / `next.route`), exceptions reduced to their type,
  no status message. That also covers Next's built-in spans on the website (its `http.target` and
  `http.url` hold the query and are dropped; a fetch span keeps only the host it called). A new
  attribute needs Joel's decision.
- **Never in the way:** span calls never throw into the work; the batch processor sends in the
  background; a failed send is dropped (`failedSpanExports()`) with one stdout warning a minute,
  `Couldn't send spans to Axiom`.
- **Why the request span is hand-made, and when to stop (Joel, 25 Nov 2026: "make a note to revert
  workarounds when a version is released that is compatible with NestJS 12"):**
  `@opentelemetry/instrumentation-nestjs-core` supports `@nestjs/core` < 12 only, and Express's
  automatic spans need the ESM loader hook (about +1 s per cold start). When a release supports
  NestJS 12 without that hook, switch to it and delete the hand-made request span (`openSpan` /
  `endSpan` in `src/event/wide-event.ts`, `spanName` in libs/http's `wide-events.ts`).
  `tools/scripts/otel-nest-check.mjs` runs weekly (tofu-drift.yml, job `otel-nestjs`) and fails
  once the latest release's supported range includes 12.
- **Cost:** about +50 ms and +7 MB per cold start (api-public-read, one CPU, measured locally).

### Deployment details (`service`, LG-10)

Every entry this library writes carries the `service` group (Joel, 24 Nov 2026: "Let's add
deployment details too"): wide, job and search events, `note` and error lines, and `writeLog`,
`createLog` and `JsonLogger` lines. All plain; nothing about a person.

| Field              | Example              | From                                                                                |
| ------------------ | -------------------- | ----------------------------------------------------------------------------------- |
| `service.name`     | `api-user`           | the first name given (`wideEvents('api-user')`), else `K_SERVICE` / `CLOUD_RUN_JOB` |
| `service.version`  | `1fb357f4c0de`       | `SERVICE_VERSION`, baked into every image (below); `dev` when unset                 |
| `service.revision` | `api-user-00042-xyz` | Cloud Run's `K_REVISION`, or a job's `CLOUD_RUN_EXECUTION`                          |
| `service.env`      | `dev`                | `GCP_PROJECT` without `heisreal-`; `local` without one                              |
| `service.region`   | `europe-west2`       | Google's metadata server, on Cloud Run only                                         |
| `service.instance` | `0069c7a2…`          | Google's metadata server (the instance id), on Cloud Run only                       |

- **Version:** Release Images (`.github/workflows/_images.yml`) passes the commit's first 12 hex
  digits as the `SERVICE_VERSION` build argument (`snapshot-<sha>` for Snapshot images and the
  local images root) to both Dockerfiles in `tools/docker`. It isn't part of the image tag (a hash
  of the build output), so an unchanged service keeps the image, and the commit, it was built from.
- **Region and instance:** read once, in the background, the first time a line is written where
  `K_SERVICE` or `CLOUD_RUN_JOB` is set (`event/instance.ts`, loaded with `@heisreal/logging/event`;
  `GCE_METADATA_HOST` points it elsewhere). Nothing waits for it: lines written before it answers,
  or if it never does (each request is cut off 2 s after it starts), simply lack the field; each
  of the two lands on its own as soon as it arrives. Locally and on the media worker's machine they
  are never written; the media worker names itself (`serviceFields('media-worker')` at start-up).

### Cold starts (`process`, LG-12)

Every request and job event carries `process.cold_start` and `process.uptime_ms` (Joel, 24 Nov
2026: "add both"). The first such event a process writes is its cold start (`true`), every later
one `false`; `uptime_ms` is how long the process had been up when that request or job started
(`process.uptime()`, read when the event starts: no extra start-up work, nothing waits). Search
events, `note` and error lines don't carry them. api-public-read adds its memory cache's part
(`cache.hit`, `cache.stale`, `cache.age_ms`, `cache.not_modified`) from `PublicCacheInterceptor`.

Outside a request or job (start-up, background work), use `writeLog` / `createLog` / `JsonLogger`
as above. Their lines carry no personal data, tokens, keys or story content.
