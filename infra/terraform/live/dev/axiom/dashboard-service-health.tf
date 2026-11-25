# Dashboard "Service health": how much each service is asked, how it answers and how fast, cold
# starts, rate limits and which versions are running. Request events only (one per API request).
# Grouped by service, route, outcome or rate-limit group (LG-8). One table reads the traces
# dataset instead: each route's slowest request with its trace id, to open in Axiom's trace view
# (`ref` is a random id, not a person, so LG-8 allows it).
locals {
  health_charts = [
    {
      id = "about", type = "Note", x = 0, y = 0, w = 12, h = 2
      text = join(" ", [
        "API requests from the wide `request` events, last 24 hours by default.",
        "Grouped by service, route and outcome only, never by person, story or address (LG-8).",
        "Managed by OpenTofu (`infra/terraform/live/dev/axiom`): edits made here are undone at the next apply.",
      ])
    },
    {
      id    = "requests", type = "Statistic", name = "Requests", x = 0, y = 2, w = 3, h = 4
      extra = { colorScheme = "Blue", showChart = true }
      apl   = <<-APL
        ${local.ds}
        | where event == "request"
        | summarize count() by bin_auto(_time)
      APL
    },
    {
      id    = "server-errors", type = "Statistic", name = "Server errors (5xx)", x = 3, y = 2, w = 3, h = 4
      extra = { colorScheme = "Red", showChart = true }
      apl   = <<-APL
        ${local.ds}
        | where event == "request"
        | summarize countif(['http.status_code'] >= 500) by bin_auto(_time)
      APL
    },
    {
      id    = "p95", type = "Statistic", name = "p95 time (ms)", x = 6, y = 2, w = 3, h = 4
      extra = { colorScheme = "Orange", showChart = true, customUnits = "ms" }
      apl   = <<-APL
        ${local.ds}
        | where event == "request"
        | summarize percentile(['http.duration_ms'], 95) by bin_auto(_time)
      APL
    },
    {
      id    = "cold-starts", type = "Statistic", name = "Cold starts", x = 9, y = 2, w = 3, h = 4
      extra = { colorScheme = "Purple", showChart = true }
      apl   = <<-APL
        ${local.ds}
        | where event == "request"
        | summarize countif(['process.cold_start'] == true) by bin_auto(_time)
      APL
    },
    {
      id  = "requests-by-service", type = "TimeSeries", name = "Requests by service", x = 0, y = 6, w = 6, h = 6
      apl = <<-APL
        ${local.ds}
        | where event == "request"
        | summarize count() by bin_auto(_time), ['service.name']
      APL
    },
    {
      id  = "p95-by-service", type = "TimeSeries", name = "p95 time by service (ms)", x = 6, y = 6, w = 6, h = 6
      apl = <<-APL
        ${local.ds}
        | where event == "request"
        | summarize percentile(['http.duration_ms'], 95) by bin_auto(_time), ['service.name']
      APL
    },
    {
      id  = "outcomes", type = "TimeSeries", name = "Outcomes", x = 0, y = 12, w = 6, h = 6
      apl = <<-APL
        ${local.ds}
        | where event == "request"
        | summarize count() by bin_auto(_time), outcome
      APL
    },
    {
      id  = "rate-limits", type = "Table", name = "Rate-limit decisions by group", x = 6, y = 12, w = 6, h = 6
      apl = <<-APL
        ${local.ds}
        | where event == "request" and isnotempty(['rate_limit.group'])
        | summarize requests = count(),
            refused = countif(['rate_limit.decision'] != "allowed")
          by ['service.name'], group = ['rate_limit.group']
        | order by refused desc, requests desc
      APL
    },
    {
      id  = "routes", type = "Table", name = "Routes: volume, failures and time", x = 0, y = 18, w = 12, h = 9
      apl = <<-APL
        ${local.ds}
        | where event == "request"
        | summarize requests = count(),
            client_errors_4xx = countif(['http.status_code'] >= 400 and ['http.status_code'] < 500),
            server_errors_5xx = countif(['http.status_code'] >= 500),
            p50_ms = percentile(['http.duration_ms'], 50),
            p95_ms = percentile(['http.duration_ms'], 95),
            max_ms = max(['http.duration_ms']),
            p95_response_bytes = percentile(['http.response_bytes'], 95)
          by ['service.name'], method = ['http.method'], route = ['http.route']
        | order by requests desc
      APL
    },
    {
      id  = "cold-vs-warm", type = "Table", name = "Cold starts by service: cold vs warm time", x = 0, y = 27, w = 6, h = 7
      apl = <<-APL
        ${local.ds}
        | where event == "request"
        | summarize cold_starts = countif(['process.cold_start'] == true),
            cold_p50_ms = percentileif(['http.duration_ms'], 50, ['process.cold_start'] == true),
            warm_p50_ms = percentileif(['http.duration_ms'], 50, ['process.cold_start'] == false),
            warm_p95_ms = percentileif(['http.duration_ms'], 95, ['process.cold_start'] == false)
          by ['service.name']
        | order by cold_starts desc
      APL
    },
    {
      id  = "versions", type = "Table", name = "Versions running (start-ups and requests)", x = 6, y = 27, w = 6, h = 7
      apl = <<-APL
        ${local.ds}
        | where isnotempty(['service.version'])
        | summarize first_seen = min(_time), last_seen = max(_time),
            start_ups = countif(isempty(event)), requests = countif(event == "request")
          by ['service.name'], version = ['service.version']
        | order by last_seen desc
      APL
    },
    {
      id = "slowest", type = "Table", name = "Slowest requests (last 24 h): each route's slowest, with its trace", x = 0, y = 34, w = 12, h = 9
      # Every service's request span (the website's pages too), from the traces dataset: one row
      # per route with its slowest request. `trace_id` opens in Axiom's trace view (Query →
      # heisreal-traces, or the trace search); `ref` is the same id as the logs write it. Spans
      # without a route (Next's inner "GET" span, static files) are left out.
      apl = <<-APL
        ${local.traces_ds}
        | where ['resource.deployment.environment.name'] == "${local.traces_env}"
            and kind == "server" and name contains " "
        | summarize requests = count(),
            p95_ms = round(percentile(duration / 1ms, 95), 1),
            arg_max(duration, trace_id, _time)
          by ['service.name'], route = name
        | extend slowest_ms = round(duration / 1ms, 1),
            ref = strcat(substring(trace_id, 0, 8), "-", substring(trace_id, 8, 4), "-",
              substring(trace_id, 12, 4), "-", substring(trace_id, 16, 4), "-", substring(trace_id, 20, 12))
        | project ['service.name'], route, slowest_ms, trace_id, ref, at = _time, requests, p95_ms
        | order by slowest_ms desc
      APL
    },
  ]
}

resource "axiom_dashboard" "service_health" {
  uid = "${local.dataset}-service-health"
  dashboard = jsonencode(merge(local.dashboard_defaults, {
    name        = "Service health (${local.dataset})"
    description = "Requests, failures, time, cold starts, rate limits, versions and the slowest requests by service and route."
    charts = [for c in local.health_charts : merge(
      { id = c.id, type = c.type },
      try({ text = c.text }, {}),
      try({ name = c.name, query = { apl = trimspace(c.apl) } }, {}),
      try(c.extra, {}),
    )]
    layout = [for c in local.health_charts : { i = c.id, x = c.x, y = c.y, w = c.w, h = c.h }]
  }))
}
