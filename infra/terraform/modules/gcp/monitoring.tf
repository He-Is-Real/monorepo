# A Cloud Monitoring dashboard, "<name>: health" (named "database restarts" until it also held the
# media worker's certificate renewals, at the bottom: worker_identity.tf; Joel, 2026-11-09, W2-4):
# database restarts (SurrealDB on Spot; Joel, 2026-11-08: "ensure
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
    [for s in google_cloud_run_v2_service.cert_signer : s.name],
  )

  # The bootstrap root names it after the cluster (`local.name`).
  spot_reclaims_metric = "logging.googleapis.com/user/${local.name}/database-spot-reclaims"

  # The worker's certificates (worker_identity.tf), at the bottom: issued per machine (a renewal
  # every 6 hours is four a day; none for a day means it stopped renewing, and its certificate
  # expires within the lifetime; more than four means a second copy may be renewing) and refusals
  # by reason.
  certificate_tiles_y = 12 + length(local.dashboard_services) * local.dashboard_row_height
  certificate_tiles = [for i, m in [for k, metric in google_logging_metric.worker_certificates : {
    title = k == "issued" ? "Worker certificates issued per machine (every 6 h each; none for a day = renewals stopped)" : "Worker certificate renewals refused or failed, by reason"
    type  = "logging.googleapis.com/user/${metric.name}"
    label = one(metric.metric_descriptor[0].labels).key
    }] : merge({
    yPos   = local.certificate_tiles_y
    width  = 24
    height = local.dashboard_row_height
    widget = {
      title = m.title
      xyChart = {
        chartOptions = { mode = "COLOR" }
        dataSets = [{
          plotType   = "STACKED_BAR"
          targetAxis = "Y1"
          timeSeriesQuery = {
            timeSeriesFilter = {
              filter = "metric.type=\"${m.type}\""
              aggregation = {
                alignmentPeriod    = "3600s"
                perSeriesAligner   = "ALIGN_SUM"
                crossSeriesReducer = "REDUCE_SUM"
                groupByFields      = ["metric.label.\"${m.label}\""]
              }
            }
          }
        }]
      }
    }
  }, i == 0 ? {} : { xPos = 24 })]

  # Mosaic layout: 48 columns; each service gets one row of two charts below the reclaims chart.
  # Leave out xPos/yPos when they are 0: Google drops zero values, so writing them makes every
  # plan show the dashboard as changed.
  dashboard_row_height = 16

  dashboard_service_tiles = flatten([for i, service in local.dashboard_services : [
    {
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
    displayName = "${local.name}: health"
    mosaicLayout = {
      columns = 48
      tiles = concat([{
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
      }], local.dashboard_service_tiles, local.certificate_tiles)
    }
  })
}
