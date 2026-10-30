# D101: the project's own logs (Cloud Run, GKE and SurrealDB output, request logs with visitors'
# IP addresses) are stored in London. Google creates every project's `_Default` log bucket in
# `global` and a bucket's location is fixed at creation, so we add a London bucket and point the
# existing `_Default` sink at it, in place. Old entries in the global `_Default` bucket expire on
# their own (30 days); Logs Explorer's project scope reads both buckets meanwhile.
#
# Google's audit logs (`_Required` sink and bucket, 400 days) are untouched: neither can be
# changed. Only a project created after the organisation's default log location is London
# (modules/org, D104, postponed by D119) gets a London `_Required` bucket.

locals {
  # Everything except Google's audit logs, which the `_Required` sink takes. The same filter
  # Google gives `_Default`, so nothing is lost or stored twice.
  default_sink_filter = join(" AND ", [for log_id in [
    "cloudaudit.googleapis.com/activity",
    "externalaudit.googleapis.com/activity",
    "cloudaudit.googleapis.com/system_event",
    "externalaudit.googleapis.com/system_event",
    "cloudaudit.googleapis.com/access_transparency",
    "externalaudit.googleapis.com/access_transparency",
  ] : "NOT LOG_ID(\"${log_id}\")"])
}

resource "google_logging_project_bucket_config" "default" {
  project        = google_project.this.project_id
  bucket_id      = "default-${var.region}"
  location       = var.region # GDPR: stays in the UK
  retention_days = 30
  description    = "The _Default sink's logs, in ${var.region} (D101)."

  # Deleting a bucket deletes its logs after 7 days; refuse it rather than lose them.
  deletion_policy = "PREVENT"
}

# Google's `_Default` sink, adopted with an import block in the live root. Only its destination
# changes; deleting it would stop storing the project's logs, so that is refused.
resource "google_logging_project_sink" "default" {
  project = google_project.this.project_id
  name    = "_Default"
  destination = join("/", [
    "logging.googleapis.com/projects", google_logging_project_bucket_config.default.project,
    "locations", google_logging_project_bucket_config.default.location,
    "buckets", google_logging_project_bucket_config.default.bucket_id,
  ])
  filter = local.default_sink_filter

  deletion_policy = "PREVENT"
}
