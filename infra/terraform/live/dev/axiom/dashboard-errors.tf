# Dashboard "Errors": requests that didn't end "ok", their error kinds, and unexpected-error lines.
# Grouped by service, route, outcome, status or error kind (LG-8). `error.type` and `error.code`
# only appear in the dataset once a service has written one, so those charts read them through
# column_ifexists() and show nothing until then instead of failing.
locals {
  errors_charts = [
    {
      id = "about", type = "Note", x = 0, y = 0, w = 12, h = 2
      text = join(" ", [
        "Requests that didn't end `ok`, by outcome, service and route, last 24 hours by default.",
        "`not_found` and `input_refused` are normal answers; `error` and `restarting` are ours.",
        "To follow one failure, take its Reference from the person and use the logs runbook.",
        "Managed by OpenTofu (`infra/terraform/live/dev/axiom`): edits made here are undone at the next apply.",
      ])
    },
    {
      id  = "not-ok-over-time", type = "TimeSeries", name = "Requests not ok, by outcome", x = 0, y = 2, w = 6, h = 6
      apl = <<-APL
        ${local.ds}
        | where event == "request" and outcome != "ok"
        | summarize count() by bin_auto(_time), outcome
      APL
    },
    {
      id  = "error-lines", type = "TimeSeries", name = "Error and warning lines by service", x = 6, y = 2, w = 6, h = 6
      apl = <<-APL
        ${local.ds}
        | where severity in ("WARNING", "ERROR", "CRITICAL")
        | summarize count() by bin_auto(_time), ['service.name'], severity
      APL
    },
    {
      id  = "failures-by-route", type = "Table", name = "Failures by service and route", x = 0, y = 8, w = 12, h = 8
      apl = <<-APL
        ${local.ds}
        | where event == "request" and outcome != "ok"
        | summarize requests = count(), last_seen = max(_time)
          by ['service.name'], method = ['http.method'], route = ['http.route'],
            status = ['http.status_code'], outcome
        | order by requests desc
      APL
    },
    {
      id  = "error-kinds", type = "Table", name = "Error kinds (error.type, error.code)", x = 0, y = 16, w = 12, h = 7
      apl = <<-APL
        ${local.ds}
        | where event == "request"
        | extend error_type = tostring(column_ifexists('error.type', '')),
            error_code = tostring(column_ifexists('error.code', ''))
        | where isnotempty(error_type) or isnotempty(error_code)
        | summarize requests = count(), last_seen = max(_time)
          by ['service.name'], route = ['http.route'], error_type, error_code
        | order by requests desc
      APL
    },
  ]
}

resource "axiom_dashboard" "errors" {
  uid = "${local.dataset}-errors"
  dashboard = jsonencode(merge(local.dashboard_defaults, {
    name        = "Errors (${local.dataset})"
    description = "Requests that didn't end ok, error kinds and error lines, by service and route."
    charts = [for c in local.errors_charts : merge(
      { id = c.id, type = c.type },
      try({ text = c.text }, {}),
      try({ name = c.name, query = { apl = trimspace(c.apl) } }, {}),
      try(c.extra, {}),
    )]
    layout = [for c in local.errors_charts : { i = c.id, x = c.x, y = c.y, w = c.w, h = c.h }]
  }))
}
