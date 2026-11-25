# Dashboard "Jobs" (LG-14b A, Joel 25 Nov 2026): background work, from the `job` events (the media
# worker's, one per job, and the result writer's, one per call from the worker) and housekeeping's
# chore lines. A job's kind is its service and `job.name` (media.check, media.render…), or its route
# for the result writer. Grouped by kind, outcome, chore and day only (LG-8). Last 7 days by
# default: jobs are few, and a per-day chart needs more than one day.
#
# Fields a job may not have written yet are read through column_ifexists(), so a chart over them
# is empty instead of failing.
locals {
  # The job's kind: "media-worker media.check", "workflow /v1/media-jobs/:job/check".
  job_kind = <<-APL
    | extend kind = strcat(['service.name'], " ", iff(
        isnotempty(tostring(column_ifexists("job.name", ""))),
        tostring(column_ifexists("job.name", "")),
        tostring(column_ifexists("http.route", ""))))
  APL

  jobs_charts = [
    {
      id = "about", type = "Note", x = 0, y = 0, w = 12, h = 2
      text = join(" ", [
        "Background jobs from the `job` events (media worker, result writer) and housekeeping's chore lines, last 7 days by default.",
        "Grouped by kind, outcome, chore and day only, never by person, story or address (LG-8).",
        "Managed by OpenTofu (`infra/terraform/live/dev/axiom`): edits made here are undone at the next apply.",
      ])
    },
    {
      id  = "jobs-per-day", type = "TimeSeries", name = "Jobs per day by kind and outcome", x = 0, y = 2, w = 12, h = 7
      apl = <<-APL
        ${local.ds}
        | where event == "job"
        ${trimspace(local.job_kind)}
        | summarize jobs = count() by bin(_time, 1d), kind, outcome
      APL
    },
    {
      id  = "durations", type = "Table", name = "Time per job by kind (ms)", x = 0, y = 9, w = 6, h = 7
      apl = <<-APL
        ${local.ds}
        | where event == "job"
        ${trimspace(local.job_kind)}
        | extend ms = tolong(column_ifexists("job.duration_ms", long(null)))
        | summarize jobs = count(), p50_ms = percentile(ms, 50), p95_ms = percentile(ms, 95), max_ms = max(ms)
          by kind
        | order by jobs desc
      APL
    },
    {
      id  = "p95-by-kind", type = "TimeSeries", name = "p95 time per job by kind (ms)", x = 6, y = 9, w = 6, h = 7
      apl = <<-APL
        ${local.ds}
        | where event == "job"
        ${trimspace(local.job_kind)}
        | summarize percentile(tolong(column_ifexists("job.duration_ms", long(null))), 95) by bin(_time, 1d), kind
      APL
    },
    {
      id  = "failures", type = "Table", name = "Failures by kind", x = 0, y = 16, w = 6, h = 7
      apl = <<-APL
        ${local.ds}
        | where event == "job" and outcome != "ok"
        ${trimspace(local.job_kind)}
        | summarize failures = count(),
            sent_back_to_queue = countif(tobool(column_ifexists("error.retriable", false)))
          by kind, outcome, code = tostring(column_ifexists("error.code", ""))
        | order by failures desc
      APL
    },
    {
      id  = "housekeeping", type = "Table", name = "Housekeeping chores per day", x = 6, y = 16, w = 6, h = 7
      apl = <<-APL
        ${local.ds}
        | where job == "housekeeping" and isnotempty(task)
        | summarize runs = count(), chore_failed = countif(severity == "ERROR"),
            deleted = sum(deleted), deletions_failed = sum(failed)
          by day = bin(_time, 1d), task
        | order by day desc, task asc
      APL
    },
  ]
}

resource "axiom_dashboard" "jobs" {
  uid = "${local.dataset}-jobs"
  dashboard = jsonencode(merge(local.dashboard_defaults, {
    name            = "Jobs (${local.dataset})"
    description     = "Background jobs per day by kind and outcome, time per job, failures, housekeeping chores."
    timeWindowStart = "qr-now-7d"
    charts = [for c in local.jobs_charts : merge(
      { id = c.id, type = c.type },
      try({ text = c.text }, {}),
      try({ name = c.name, query = { apl = trimspace(c.apl) } }, {}),
    )]
    layout = [for c in local.jobs_charts : { i = c.id, x = c.x, y = c.y, w = c.w, h = c.h }]
  }))
}
