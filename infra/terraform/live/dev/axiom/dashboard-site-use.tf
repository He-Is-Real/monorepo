# Dashboard "How the site is used" (LG-14c, Joel 25 Nov 2026; LG-8 allows grouping by device
# type, theme and search term): which devices and browsers ask for pages, bots vs people, popular
# themes, top search terms, searches per day and how often a search finds nothing. Page requests
# are the website's own `request` events (`service.name` web); searches are the `search` events.
# Never by person, story or address: nothing here lists a user, a session, an address or a story.
# Users and popular pages wait for LG-14d (counts vs a list; page kinds vs individual stories).
# Last 7 days by default: searches are few, and a per-day chart needs more than one day.
#
# Fields not written yet are read through column_ifexists(), so a chart over them is empty
# instead of failing.
locals {
  site_use_charts = [
    {
      id = "about", type = "Note", x = 0, y = 0, w = 12, h = 2
      text = join(" ", [
        "How the site is used, last 7 days by default: the website's page requests and the search events.",
        "Grouped by device type, browser, theme, search term and day only, never by person, story or address (LG-8).",
        "Managed by OpenTofu (`infra/terraform/live/dev/axiom`): edits made here are undone at the next apply.",
      ])
    },
    {
      id  = "bots-vs-people", type = "TimeSeries", name = "Page requests: bots vs people", x = 0, y = 2, w = 6, h = 6
      apl = <<-APL
        ${local.ds}
        | where event == "request" and ['service.name'] == "web"
        | extend who = iff(tostring(column_ifexists("client.device", "")) == "bot", "bots", "people")
        | summarize count() by bin_auto(_time), who
      APL
    },
    {
      id  = "devices", type = "Pie", name = "Page requests by device type", x = 6, y = 2, w = 3, h = 6
      apl = <<-APL
        ${local.ds}
        | where event == "request" and ['service.name'] == "web"
        | summarize count() by device = tostring(column_ifexists("client.device", "unknown"))
      APL
    },
    {
      id  = "browsers", type = "Pie", name = "Page requests by browser", x = 9, y = 2, w = 3, h = 6
      apl = <<-APL
        ${local.ds}
        | where event == "request" and ['service.name'] == "web"
        | extend browser = replace_regex(@" [0-9]+$", "", tostring(column_ifexists("client.browser", "")))
        | summarize count() by browser = iff(isempty(browser), "unknown", browser)
      APL
    },
    {
      id  = "searches-per-day", type = "TimeSeries", name = "Searches per day", x = 0, y = 8, w = 6, h = 6
      apl = <<-APL
        ${local.ds}
        | where event == "search"
        | summarize searches = count() by bin(_time, 1d)
      APL
    },
    {
      id  = "found-nothing", type = "Table", name = "Searches that found nothing, per day", x = 6, y = 8, w = 6, h = 6
      apl = <<-APL
        ${local.ds}
        | where event == "search"
        | extend results = tolong(column_ifexists("search.result_count", long(null)))
        | summarize searches = count(), with_a_count = countif(isnotnull(results)),
            found_nothing = countif(results == 0)
          by day = bin(_time, 1d)
        | extend found_nothing_pct = iff(with_a_count > 0, round(100.0 * found_nothing / with_a_count, 1), real(null))
        | order by day desc
      APL
    },
    {
      id  = "themes", type = "Table", name = "Popular themes (searched for)", x = 0, y = 14, w = 6, h = 8
      apl = <<-APL
        ${local.ds}
        | where event == "search"
        | extend tags = column_ifexists("search.tags", dynamic([]))
        | mv-expand tags
        | where isnotempty(tags)
        | summarize searches = count() by theme = tostring(tags)
        | top 20 by searches
      APL
    },
    {
      id  = "terms", type = "Table", name = "Top search terms", x = 6, y = 14, w = 6, h = 8
      apl = <<-APL
        ${local.ds}
        | where event == "search"
        | extend term = tolower(trim_space(tostring(column_ifexists("search.q", ""))))
        | where isnotempty(term)
        | summarize searches = count() by term
        | top 25 by searches
      APL
    },
    {
      id = "waiting", type = "Note", x = 0, y = 22, w = 12, h = 2
      text = join(" ", [
        "**Waiting for Joel (LG-14d): users and popular pages.**",
        "Whether users are shown as counts only, and whether popular pages are page kinds or individual stories, is still open; nothing here lists a person or a story until it is decided.",
      ])
    },
  ]
}

resource "axiom_dashboard" "site_use" {
  uid = "${local.dataset}-site-use"
  dashboard = jsonencode(merge(local.dashboard_defaults, {
    name            = "How the site is used (${local.dataset})"
    description     = "Devices, browsers, bots vs people, popular themes, top search terms, searches per day, searches that found nothing."
    timeWindowStart = "qr-now-7d"
    charts = [for c in local.site_use_charts : merge(
      { id = c.id, type = c.type },
      try({ text = c.text }, {}),
      try({ name = c.name, query = { apl = trimspace(c.apl) } }, {}),
    )]
    layout = [for c in local.site_use_charts : { i = c.id, x = c.x, y = c.y, w = c.w, h = c.h }]
  }))
}
