# Dashboard "Database, outside calls and cache": time spent in SurrealDB and in Clerk and Bunny
# calls, the slowest database queries by name, and api-public-read's memory cache. Grouped by
# service, route or query name (LG-8). The `external.*` fields only appear once a service has
# timed such a call, so those charts read them through column_ifexists().
locals {
  calls_charts = [
    {
      id = "about", type = "Note", x = 0, y = 0, w = 12, h = 2
      text = join(" ", [
        "Where request time goes: SurrealDB (`db.*`), Clerk and Bunny (`external.*`), and api-public-read's memory cache (`cache.*`).",
        "Last 24 hours by default. Managed by OpenTofu (`infra/terraform/live/dev/axiom`): edits made here are undone at the next apply.",
      ])
    },
    {
      id  = "db-p95-by-service", type = "TimeSeries", name = "Database time per request, p95 by service (ms)", x = 0, y = 2, w = 6, h = 6
      apl = <<-APL
        ${local.ds}
        | where event == "request" and isnotnull(['db.total_ms'])
        | summarize percentile(['db.total_ms'], 95) by bin_auto(_time), ['service.name']
      APL
    },
    {
      id  = "cache-hit-rate", type = "TimeSeries", name = "api-public-read: answered from memory (%)", x = 6, y = 2, w = 6, h = 6
      apl = <<-APL
        ${local.ds}
        | where event == "request" and ['service.name'] == "api-public-read" and isnotnull(['cache.hit'])
        | summarize hit_percent = 100.0 * countif(['cache.hit'] == true) / count() by bin_auto(_time)
      APL
    },
    {
      id  = "db-by-route", type = "Table", name = "Database work by route", x = 0, y = 8, w = 12, h = 8
      apl = <<-APL
        ${local.ds}
        | where event == "request" and isnotnull(['db.calls'])
        | summarize requests = count(),
            avg_db_calls = avg(['db.calls']),
            db_p50_ms = percentile(['db.total_ms'], 50),
            db_p95_ms = percentile(['db.total_ms'], 95),
            request_p95_ms = percentile(['http.duration_ms'], 95)
          by ['service.name'], method = ['http.method'], route = ['http.route']
        | order by db_p95_ms desc
      APL
    },
    {
      id  = "slowest-queries", type = "Table", name = "Slowest database queries by name", x = 0, y = 16, w = 6, h = 8
      apl = <<-APL
        ${local.ds}
        | where isnotempty(['db.slowest.name'])
        | summarize times_slowest = count(),
            p50_ms = percentile(['db.slowest.ms'], 50),
            p95_ms = percentile(['db.slowest.ms'], 95),
            max_ms = max(['db.slowest.ms'])
          by query = ['db.slowest.name']
        | order by p95_ms desc
      APL
    },
    {
      id  = "cache-by-route", type = "Table", name = "api-public-read cache by route", x = 6, y = 16, w = 6, h = 8
      apl = <<-APL
        ${local.ds}
        | where event == "request" and ['service.name'] == "api-public-read"
        | summarize requests = count(),
            from_memory = countif(['cache.hit'] == true),
            stale_served = countif(['cache.stale'] == true),
            not_modified_304 = countif(['cache.not_modified'] == true),
            p95_age_ms = percentile(['cache.age_ms'], 95)
          by route = ['http.route']
        | order by requests desc
      APL
    },
    {
      id  = "outside-calls", type = "Table", name = "Clerk and Bunny calls by service and route", x = 0, y = 24, w = 12, h = 7
      apl = <<-APL
        ${local.ds}
        | where event in ("request", "job")
        | extend clerk_calls = toint(column_ifexists('external.clerk.calls', int(null))),
            clerk_ms = toreal(column_ifexists('external.clerk.ms', real(null))),
            bunny_calls = toint(column_ifexists('external.bunny.calls', int(null))),
            bunny_ms = toreal(column_ifexists('external.bunny.ms', real(null)))
        | where clerk_calls > 0 or bunny_calls > 0
        | summarize requests = count(),
            clerk_calls = sum(clerk_calls), clerk_p95_ms = percentile(clerk_ms, 95),
            bunny_calls = sum(bunny_calls), bunny_p95_ms = percentile(bunny_ms, 95)
          by ['service.name'], route = ['http.route']
        | order by requests desc
      APL
    },
  ]
}

resource "axiom_dashboard" "database_and_calls" {
  uid = "${local.dataset}-database-and-calls"
  dashboard = jsonencode(merge(local.dashboard_defaults, {
    name        = "Database, outside calls and cache (${local.dataset})"
    description = "Time in SurrealDB, Clerk and Bunny, slowest queries by name, and api-public-read's memory cache."
    charts = [for c in local.calls_charts : merge(
      { id = c.id, type = c.type },
      try({ text = c.text }, {}),
      try({ name = c.name, query = { apl = trimspace(c.apl) } }, {}),
      try(c.extra, {}),
    )]
    layout = [for c in local.calls_charts : { i = c.id, x = c.x, y = c.y, w = c.w, h = c.h }]
  }))
}
