# A Cloud Monitoring dashboard for database restarts (SurrealDB on Spot; Joel, 2026-11-08: "ensure
# even gcp dashboards are defined in OpenTofu"). Dashboards live here only: one made or changed
# in the Console is overwritten by the next apply. No alert policies or notification channels
# (not decided yet).
#
# Per Cloud Run service: requests by response code (a restart shows as 503s) and instances
# running; at the top, how often Google took the database's Spot node back (the
# `database-spot-reclaims` log-based metric, bootstrap root, modules/bootstrap/logging.tf).
# Free: Cloud Run's metrics and dashboards cost nothing.

locals {
  dashboard_services = concat(
    ["web", google_cloud_run_v2_service.api_public_read.name],
    [for name, _ in local.signed_in_apis : google_cloud_run_v2_service.signed_in_api[name].name],
    [for s in google_cloud_run_v2_service.result_writer : s.name],
  )

  # The bootstrap root names it after the cluster (`local.name`).
  spot_reclaims_metric = "logging.googleapis.com/user/${local.name}/database-spot-reclaims"

  # Mosaic layout: 48 columns; each service gets one row of two charts below the reclaims chart.
  dashboard_row_height = 16

  dashboard_service_tiles = flatten([for i, service in local.dashboard_services : [
    {
      xPos   = 0
      yPos   = 12 + i * local.dashboard_row_height
      width  = 24
      height = local.dashboard_row_height
      widget = {
        title = "${service}: requests per second by response code"
        xyChart = {
          chartOptions = { mode = "COLOR" }
          dataSets = [{
            plotType   = "STACKED_AREA"
            targetAxis = "Y1"
            timeSeriesQuery = {
              timeSeriesFilter = {
                filter = join(" AND ", [
                  "metric.type=\"run.googleapis.com/request_count\"",
                  "resource.type=\"cloud_run_revision\"",
                  "resource.label.\"service_name\"=\"${service}\"",
                ])
                aggregation = {
                  alignmentPeriod    = "60s"
                  perSeriesAligner   = "ALIGN_RATE"
                  crossSeriesReducer = "REDUCE_SUM"
                  groupByFields      = ["metric.label.\"response_code\""]
                }
              }
            }
          }]
        }
      }
    },
    {
      xPos   = 24
      yPos   = 12 + i * local.dashboard_row_height
      width  = 24
      height = local.dashboard_row_height
      widget = {
        title = "${service}: instances"
        xyChart = {
          chartOptions = { mode = "COLOR" }
          dataSets = [{
            plotType   = "STACKED_AREA"
            targetAxis = "Y1"
            timeSeriesQuery = {
              timeSeriesFilter = {
                filter = join(" AND ", [
                  "metric.type=\"run.googleapis.com/container/instance_count\"",
                  "resource.type=\"cloud_run_revision\"",
                  "resource.label.\"service_name\"=\"${service}\"",
                ])
                aggregation = {
                  alignmentPeriod    = "60s"
                  perSeriesAligner   = "ALIGN_MAX"
                  crossSeriesReducer = "REDUCE_SUM"
                  groupByFields      = ["metric.label.\"state\""] # active / idle
                }
              }
            }
          }]
        }
      }
    },
  ]])
}

resource "google_monitoring_dashboard" "database_restarts" {
  project = var.project_id
  dashboard_json = jsonencode({
    displayName = "${local.name}: database restarts"
    mosaicLayout = {
      columns = 48
      tiles = concat([{
        xPos   = 0
        yPos   = 0
        width  = 48
        height = 12
        widget = {
          title = "Database Spot node reclaimed by Google (each one restarts SurrealDB)"
          xyChart = {
            chartOptions = { mode = "COLOR" }
            dataSets = [{
              plotType   = "STACKED_BAR"
              targetAxis = "Y1"
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"${local.spot_reclaims_metric}\""
                  aggregation = {
                    alignmentPeriod    = "3600s"
                    perSeriesAligner   = "ALIGN_SUM"
                    crossSeriesReducer = "REDUCE_SUM"
                  }
                }
              }
            }]
          }
        }
      }], local.dashboard_service_tiles)
    }
  })
}
