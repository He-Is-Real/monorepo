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
- **Timings:** `timeDb(name, work)` (libs/database's `runQuery` already does it), `timeExternal(name,
work)` and `timedFetch(name, fetch)` for Clerk, Bunny, Stripe, Resend → `db { calls, total_ms,
slowest { name, ms } }`, `external.<name> { calls, ms, status }`.
- **Facts from shared code:** `note(fields, { severity, message })` puts the fields on the current
  event, or writes one line when there is none (start-up, background work, a job without an event)
  or when it was already written (the caller hung up mid-work): that line carries the request's
  `ref`, trace field and `service`, so a record like an erasure is never lost.
- **Errors:** `event.fail({ type, code, retriable, message })` (our own words); the immediate
  unexpected-error line is `writeErrorLine(err, { ref, traceId })` (`stack_trace`, for Error
  Reporting). `ProblemFilter` (libs/http) does both for the APIs.

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
  an interceptor around its answer cache, so a search answered from memory is still logged.
- **Keys:** `log-hmac` (general, `hk1:`) and `log-search-hmac` (search only, `hs1:`) in Secret
  Manager, named by `LOG_HMAC_SECRET` and `LOG_SEARCH_HMAC_SECRET` and read at start-up by
  `LogKeysModule` (libs/http). A deployed service (`K_SERVICE` set) refuses to start without both.
  Unset locally and in tests: fixed development keys (`DEV_LOG_KEYS`), never a real one, with a
  start-up warning.
- **Size:** Google refuses an entry over 256 KB. An entry over `MAX_ENTRY_BYTES` (200 000) has its
  plain long text cut, longest first (`debug.truncated_fields`; `_length` keeps the full length);
  if still too long, only the envelope, `http`, `action`, `outcome` and `error` are kept
  (`debug.oversized`).
- **Where it goes:** `LOG_SINKS`, today only stdout (Cloud Run hands it to Cloud Logging, London).
  The media worker, off Google Cloud, adds its own Cloud Logging sink there
  (apps/media-worker/src/cloud-logging.ts). Axiom (LG-3) is a second sink added there once the
  account exists; until then read logs with
  `gcloud logging read 'jsonPayload.ref="<ref>"' --project heisreal-dev --freshness=1d --format=json`
  (Axiom once the account exists). A sink that throws is counted (`failedLogWrites()`), never
  thrown into the request. No sampling, no tracing library.

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

Outside a request or job (start-up, background work), use `writeLog` / `createLog` / `JsonLogger`
as above. Their lines carry no personal data, tokens, keys or story content.
