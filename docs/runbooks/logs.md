# Logs runbook

How to find things in our logs: a request from its reference, a person's visit, errors, slow calls,
media jobs and search counts. The rules for writing logs are in the writing-logs skill
(`.agents/skills/writing-logs/SKILL.md`) and AGENTS.md "Logging"; the decisions are LG-1 to LG-9 in
`../project/context/research/logging.html`.

## Contents

- How agents read logs
- The events
- Reading with gcloud
- Dashboards
- Counts (stats)
- Local runs

**Where logs are.** Every service writes one JSON line per event to stdout; Cloud Run hands it to
Cloud Logging, London bucket, kept 30 days, everything kept (no sampling, LG-6 A). The media worker
runs off Google and sends its own lines there as the `media-worker` account (log name
`media-worker`). Every service and the media worker also send each line, unchanged, to **Axiom**
(LG-3): dataset `heisreal-dev`, edge deployment EU Central 1 (Frankfurt), kept 30 days. Cloud Run
also writes its own line per request (status, latency, IP, browser), only in Google, except for
search addresses, which a log filter drops (LG-2g A).

**Read in Axiom first (LG-5).** Open Axiom → Query, dataset `heisreal-dev`, and filter in APL:

```kusto
['heisreal-dev'] | where ref == "0199c3e2-7b4a-7c3e-9f00-1a2b3c4d5e6f"
['heisreal-dev'] | where outcome == "error" | sort by _time desc
['heisreal-dev'] | where ['service.name'] == "api-user" and ['http.route'] == "/v1/me"
```

Nested fields are flattened with dots (`['http.status_code']`, `['user.id']`). Use `gcloud logging
read` (below) for Cloud Run's own request lines, for anything older than Axiom has, or when Axiom
is down. A service whose Axiom token is missing writes `Logs go to stdout only, not to Axiom` at
start-up; one that can't reach Axiom writes `Couldn't send log lines to Axiom` (at most once a
minute, with `dropped_count`); both lines are in Google only.

## How agents read logs

Agents read Axiom through the **Axiom MCP** server (tool `queryDataset`, APL; `getDatasetFields`
lists the real field names) or the **Axiom CLI** (`axiom query`). Both are set up once per
developer machine, outside the repo ([tooling-and-accounts.md](../tooling-and-accounts.md), "Axiom");
`mise.toml` points the CLI at our EU edge. Agents only read: they never create, change or delete
anything in Axiom (the dataset, the dashboards and, later, monitors are OpenTofu's,
`infra/terraform/live/dev/axiom`).

```sh
axiom query "['heisreal-dev'] | where ref == '<reference>'" --start-time -1h -f json
```

`-f json` prints one JSON object per line; `--start-time` takes `-1h`, `-1d` or a timestamp. Keep
the window as short as the question allows. Dotted names need brackets (`['service.name']`). A
query that names a field nobody has written yet fails with "field … not found" (Axiom only knows
fields it has seen; the full list is `libs/logging/src/fields.ts`), so check the fields first.

```kusto
// Everything one request wrote, in order (from the reference a person sends)
['heisreal-dev'] | where ref == "1a4c4701-e029-3187-a10c-05bd785d8f90" | sort by _time asc
  | project _time, ['service.name'], event, outcome, ['http.route'], ['http.status_code'], message
// Failed requests by service and route
['heisreal-dev'] | where event == "request" and ['http.status_code'] >= 400
  | summarize count() by ['service.name'], ['http.route'], outcome
// A service's last start-up: the lines with no event, newest first, and the revision that started
['heisreal-dev'] | where ['service.name'] == "api-user" and isempty(event)
  | sort by _time desc | take 10 | project _time, ['service.revision'], context, message
// First requests after a cold start, and how long they took
['heisreal-dev'] | where ['process.cold_start'] == true
  | project _time, ['service.name'], ['http.route'], ['http.duration_ms']
```

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
`db.total_ms` / `db.slowest`, `external.<bunny|clerk|stripe|resend>.ms`, `job.id`, `job.steps`, `job.duration_ms` (a job's whole time),
`process.cold_start` / `process.uptime_ms` (the first request or job a running copy handled, and how
long it had been up), and on api-public-read `cache.hit`, `cache.stale`, `cache.age_ms`,
`cache.not_modified` (LG-12).
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

### A request's timeline (spans, LG-15)

Every request and job is also an OpenTelemetry span in Axiom's `heisreal-traces` dataset, with its
database queries and outside calls (Clerk, Bunny) as child spans; on the website, Next's own spans
(render, fetches) too. The trace id is the reference without dashes. To open the timeline: Axiom →
Query, then

```kusto
['heisreal-traces'] | where trace_id == "019ab7c43df67f13903075f14addacc4"
```

and pick any row's trace id to open the trace view (waterfall). Or start from the Service health
dashboard's "Slowest requests" table (below, Dashboards): copy a row's `trace_id` into that query.
Or query the slowest yourself:

```kusto
['heisreal-traces'] | where kind == "server" and ['service.name'] == "api-user"
  | top 20 by duration desc | project _time, name, duration, trace_id
```

Span names are route patterns (`GET /v1/stories/:id`), `db <query name>` and `<service>
<method>`; attributes are only plain low-variety fields (route, method, status, outcome, error type
and code, query name, job name, cold start and uptime), never anything about a person or story; in Axiom they are under
`attributes.` (`['attributes.http.route']`), and `service.name` is top level. The dataset holds dev
and production (later) together: each span carries `deployment.environment.name` (`dev`, `prod`) as a resource
attribute, with `service.region` and `service.instance` (check the exact field names with
`getDatasetFields` once spans have arrived). Only request and job timelines are there: Next's
start-up work (an instance loading its route modules) is not sent, nor our own sends to Axiom
(the log sink's fetch, which Next records inside a page request: any span whose host is
`AXIOM_DOMAIN` is dropped). Spans the services
couldn't send are counted in their `Couldn't send spans to Axiom` warning (stdout, at most once a
minute). The media worker's job span starts its own trace (Dapr doesn't hand Pub/Sub attributes
over, below); its calls to the result writer continue it.

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
writer's events for that delivery carry the same `ref`. The writer's answer events keep
`job.arrived_at`, the time stale answers are ordered by. If the worker hung up while the writer was
still busy, the writer's last facts (`job.failure_code`, `job.retry`, `job.result`) come on their own
line ("Media job call finished after the worker hung up") with the same `ref` and `job.id`, so the
query below still finds them. To follow one job across its deliveries:

```sh
gcloud logging read 'jsonPayload.job.id="01JC00000000000000000000AB"' --project heisreal-dev --freshness=7d --order=asc --format=json | pnpm -s logs -v
# Only the worker's lines (start-up, certificate renewals, jobs)
gcloud logging read 'logName="projects/heisreal-dev/logs/media-worker"' --project heisreal-dev --format=json | pnpm -s logs
```

**Not joined yet:** the request that queued a job (api-user, the writer) puts its trace id on the
Pub/Sub message as a `traceparent` attribute, but Dapr's Google Pub/Sub component (1.19) doesn't
hand message attributes to the worker, so the worker's `ref` is its own. Join the two by `job.id`
or the video's id (`job.video_id`) for now.

More on the media pipeline: `docs/runbooks/media.md`.

## Dashboards

Three Axiom dashboards read `heisreal-dev`. They are OpenTofu's (`infra/terraform/live/dev/axiom`,
one `dashboard-*.tf` file each): a change made in Axiom's editor is undone at the next apply, and the
weekly drift check reports it. Change the file instead. Auto-refresh is off: a dashboard only
queries while it's open, and every query uses the free plan's 10 GB-hours a month. Like every stat
(LG-8), no chart lists or groups by a person, a story or an address; the site-use dashboard also
groups by device type, browser, theme and search term (LG-8 as widened by LG-14c).

| Dashboard                           | Opens on      | What it shows                                                                                                                                                                                                                             |
| ----------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service health (heisreal-dev)       | last 24 hours | requests, 5xx, p95 time and cold starts; requests and p95 by service; outcomes; rate-limit decisions by group; each route's volume, 4xx/5xx and time; cold vs warm time; versions running; each route's slowest request with its trace id |
| Jobs (heisreal-dev)                 | last 7 days   | jobs per day by kind and outcome; time per job (`job.duration_ms`) p50/p95/max by kind; failures by kind, outcome and code; housekeeping chores per day                                                                                   |
| How the site is used (heisreal-dev) | last 7 days   | the website's page requests by device type and browser, bots vs people; searches per day; searches that found nothing; popular themes searched for; top search terms                                                                      |

**From a slow request to its timeline:** Service health's "Slowest requests" table reads
`heisreal-traces` (dev's request spans, the website's pages included): one row per route with its
slowest request's time, `trace_id` and `ref` (the same id with dashes, as the logs write it). Axiom
can't make a dashboard column open a trace, so copy the `trace_id` into Query
(`['heisreal-traces'] | where trace_id == "…"`, above) and open the trace view from a row, or
search the logs with the `ref`. A trace id is a random id, not a person (LG-8 allows it).

A job's kind is its service and `job.name` (the media worker's `media.check`, `media.render`…), or
the route for the result writer's events. Users and popular pages wait for Joel's choice (LG-14d);
the site-use dashboard keeps a marked place for them. A chart over a field nobody has written yet
(`job.duration_ms`, `search.*`, `client.browser`) stays empty instead of failing: it reads the
field through `column_ifexists()`.

## Counts (stats)

LG-8: stats are Axiom queries, grouped **only** by route, service, outcome, action or day,
**never** by person, story or address, for example
`['heisreal-dev'] | where event == "request" | summarize count() by ['service.name'], ['http.route'], outcome`.
The dashboards above hold the usual ones. Nothing is set up in Google for stats (no Log Analytics,
metrics or dashboards). When Axiom can't be used, count a day's events locally with `jq`, keeping to the same groups:

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
# Cold starts per service and day: how many, and their average and slowest time (LG-12)
gcloud logging read 'jsonPayload.process.cold_start=true' --project heisreal-dev --freshness=7d --format=json \
  | jq -r 'map({k: "\(.timestamp[0:10]) \(.jsonPayload.service.name)", ms: .jsonPayload.http.duration_ms}) | group_by(.k)[]
      | "\(.[0].k) cold_starts=\(length) avg_ms=\(map(.ms // 0) | add / length | floor) max_ms=\(map(.ms // 0) | max)"'
# Memory-cache hit rate on api-public-read, per route and day (stale = served while the database was away)
gcloud logging read 'jsonPayload.service.name="api-public-read" AND jsonPayload.cache.hit:*' --project heisreal-dev --freshness=1d --format=json \
  | jq -r 'map({k: "\(.timestamp[0:10]) \(.jsonPayload.http.route)", c: .jsonPayload.cache}) | group_by(.k)[]
      | "\(.[0].k) requests=\(length) hit_pct=\((map(select(.c.hit)) | length) * 100 / length | floor) stale=\(map(select(.c.stale)) | length) not_modified=\(map(select(.c.not_modified)) | length)"'
```

A job's cold start (the result writer, the media worker) has no `http.duration_ms`; use
`job.steps` there.

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
