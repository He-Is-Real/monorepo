# Logs runbook

How to find things in our logs: a request from its reference, a person's visit, errors, slow calls,
media jobs and search counts. The rules for writing logs are in the writing-logs skill
(`.claude/skills/writing-logs/SKILL.md`) and AGENTS.md "Logging"; the decisions are LG-1 to LG-9 in
`../project/context/research/logging.html`.

**Where logs are today.** Every service writes one JSON line per event to stdout; Cloud Run hands it
to Cloud Logging, London bucket, kept 30 days, everything kept (no sampling, LG-6 A). The media
worker runs off Google and sends its own lines there as the `media-worker` account (log name
`media-worker`). Cloud Run also writes its own line per request (status, latency, IP, browser),
except for search addresses, which a log filter drops (LG-2g A).

**Axiom once the account exists.** Joel and agents will read in Axiom first (LG-5), with saved
Axiom queries for the stats below (LG-8: stats in Axiom only). Until the account exists, use
`gcloud logging read` or the Cloud Console's Logs Explorer as below. When Axiom arrives, this page
gets its saved queries and `gcloud` stays for Google's copy and Cloud Run's own lines.

## The events

| `event`        | One per                                      | Has `ref`                     |
| -------------- | -------------------------------------------- | ----------------------------- |
| `request`      | API request (and website request, later)     | yes                           |
| `job`          | media job at the worker; call to the writer  | yes                           |
| `search`       | search (terms plain, who searched hashed)    | **no**, nothing joins it      |
| `error`        | unexpected error, the moment it happens      | yes, with `stack_trace`       |
| `error_report` | browser crash or "no answer" (website build) | yes                           |
| (none)         | start-up, background work                    | no (`ref` if after a request) |

Main fields: `ref`, `service.name`, `http.route`, `http.status_code`, `http.duration_ms`,
`outcome` (`ok`, `input_refused`, `not_found`, `rate_limited`, `restarting`, `refused`, `error`),
`action`, `error.type` / `error.code`, `user.id`, `user.session_hash`, `story.id`,
`db.total_ms` / `db.slowest`, `external.<bunny|clerk|stripe|resend>.ms`, `job.id`, `job.steps`.
The full list is LG-2 of the decision doc.

## Reading with gcloud

Read-only; any developer login with Logs Viewer. `--project heisreal-dev` for dev (prod at Go
live). Add `--freshness=7d` (default 1 day) for older lines, `--limit` to cap them, and pipe to
`pnpm -s logs -v` for one readable line per event:

```sh
gcloud logging read '<filter>' --project heisreal-dev --freshness=1d --format=json | pnpm -s logs -v
```

In the **Logs Explorer** (Cloud Console → Logging → Logs Explorer, project `heisreal-dev`), paste
the same filter into the query box.

### From a reference to the cause

Someone sends "Reference: 019ab7c4-…". Every line of that request has it:

```sh
gcloud logging read 'jsonPayload.ref="019ab7c4-3df6-7f13-9030-75f14addacc4"' \
  --project heisreal-dev --freshness=7d --format=json | pnpm -s logs -v
```

1. The `request` (or `job`) event says what happened: `outcome`, `error.type/code`, `http.route`,
   timings, who.
2. An unexpected error also has its `event: "error"` line with `stack_trace` (also in Error
   Reporting).
3. Cloud Run's own line for it (status, latency, IP): the same id without dashes as the trace,
   `trace="projects/heisreal-dev/traces/019ab7c43df67f13903075f14addacc4"`.

A reference with no lines never reached us; a UUID v7 still tells you when it was made (its first
12 hex digits are the Unix time in milliseconds).

### A person's visit

Find one of their events (by user id, or by a reference they sent), take its
`user.session_hash`, then read the whole visit in order:

```sh
gcloud logging read 'jsonPayload.user.id="user_2abc…"' --project heisreal-dev --freshness=7d --limit=1 --format='value(jsonPayload.user.session_hash)'
gcloud logging read 'jsonPayload.user.session_hash="hk1:…"' --project heisreal-dev --freshness=7d --order=asc --format=json | pnpm -s logs
```

`user.token_hash` answers "was this exact token used?" the same way. Search events have neither
(LG-2g A): a person's searches can't be found this way, and don't build tooling that does.

### Errors

```sh
# Requests and jobs that failed on our side
gcloud logging read 'severity>=ERROR AND jsonPayload.outcome="error"' --project heisreal-dev --format=json | pnpm -s logs
# The stack traces (or Error Reporting in the Console)
gcloud logging read 'jsonPayload.event="error"' --project heisreal-dev --format=json | pnpm -s logs -v
# One kind of failure
gcloud logging read 'jsonPayload.error.code="video_mismatch"' --project heisreal-dev --format=json | pnpm -s logs
# Refusals and rate limits (warnings)
gcloud logging read 'jsonPayload.outcome=("input_refused" OR "rate_limited")' --project heisreal-dev --format=json | pnpm -s logs -v
```

Long text (story text, transcripts, request bodies) is in full on `error`, `input_refused` and
`rate_limited` events (`debug.plain_content: true`), and only a hash otherwise.

### Slow calls

```sh
gcloud logging read 'jsonPayload.http.duration_ms>2000' --project heisreal-dev --format=json | pnpm -s logs
gcloud logging read 'jsonPayload.db.total_ms>500' --project heisreal-dev --format=json | pnpm -s logs -v   # db.slowest names the query
gcloud logging read 'jsonPayload.external.bunny.ms>1000' --project heisreal-dev --format=json | pnpm -s logs -v
```

### Media jobs

The worker writes one `event: "job"` per delivery (`job.id`, `job.name` `media.check` or
`media.render`, `job.steps` with each step's time and outcome, `job.output_bytes`,
`job.delivery`: `SUCCESS`, `RETRY` or `DROP`). It sends its `ref` to the result writer, so the
writer's events for that delivery carry the same `ref`. To follow one job across its deliveries:

```sh
gcloud logging read 'jsonPayload.job.id="01JC00000000000000000000AB"' --project heisreal-dev --freshness=7d --order=asc --format=json | pnpm -s logs -v
# Only the worker's lines (start-up, certificate renewals, jobs)
gcloud logging read 'logName="projects/heisreal-dev/logs/media-worker"' --project heisreal-dev --format=json | pnpm -s logs
```

**Not joined yet:** the request that queued a job (api-user, the writer) puts its trace id on the
Pub/Sub message as a `traceparent` attribute, but Dapr's Google Pub/Sub component (1.19) doesn't
hand message attributes to the worker, so the worker's `ref` is its own. Join the two by `job.id`
or the video's id (`job.video_id`) for now.

More on the media pipeline: `docs/media-runbook.md`.

## Counts (stats)

LG-8: stats are Axiom queries (once the account exists), grouped **only** by route, service,
outcome, action or day, **never** by person, story or address. Nothing is set up in Google for
stats (no Log Analytics, metrics or dashboards). Until Axiom, count a day's events locally with
`jq`, keeping to those groups:

```sh
# Requests by route and outcome, last day
gcloud logging read 'jsonPayload.event="request"' --project heisreal-dev --freshness=1d --format=json \
  | jq -r '.[].jsonPayload | "\(.service.name) \(.http.route) \(.outcome)"' | sort | uniq -c | sort -rn
# Actions by outcome
gcloud logging read 'jsonPayload.action:*' --project heisreal-dev --freshness=1d --format=json \
  | jq -r '.[].jsonPayload | "\(.action) \(.outcome)"' | sort | uniq -c | sort -rn
# Searches per day and outcome, and how many found nothing
gcloud logging read 'jsonPayload.event="search"' --project heisreal-dev --freshness=7d --format=json \
  | jq -r '.[] | "\(.timestamp[0:10]) \(.jsonPayload.outcome) \(if .jsonPayload.search.result_count == 0 then "no_results" else "results" end)"' | sort | uniq -c
```

`gcloud logging read` returns every matching entry unless you add `--limit`; keep `--freshness`
short (reading is free within Google's quotas, but keep it to what you need).

## Local runs

Services write the same JSON locally. Pipe a service's output through the pretty-printer:

```sh
pnpm nx serve api-user 2>&1 | pnpm -s logs        # time, severity, service, event, message, outcome, ref
pnpm nx serve api-user 2>&1 | pnpm -s logs -v     # plus every other field
```

Locally there is no project, so events have no `logging.googleapis.com/trace` field, and hashes
use the fixed development keys.
