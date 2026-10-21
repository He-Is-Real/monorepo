# GKE Autopilot gives every node a 100 GB boot disk, and they all count towards the regional
# SSD_TOTAL_GB quota (300 GB by default). Two nodes plus the 5 GB SurrealDB disk already use
# 205 GB, so a third node (e.g. a spot node in the database disk's zone after a preemption)
# couldn't be created and SurrealDB stayed unscheduled (2026-10-21). Autopilot bills pod
# requests, not node boot disks, so this is a ceiling, not a cost.
resource "google_cloud_quotas_quota_preference" "ssd_total_gb" {
  parent        = "projects/${google_project.this.project_id}"
  name          = "compute_googleapis_com-ssd-total-gb-${var.region}"
  service       = "compute.googleapis.com"
  quota_id      = "SSD-TOTAL-GB-per-project-region"
  dimensions    = { region = var.region }
  contact_email = trimprefix(var.developers[0], "user:")
  justification = "GKE Autopilot node boot disks (100 GB each) exhaust the default 300 GB; needed so nodes can be replaced after spot preemption."

  quota_config {
    preferred_value = 600
  }

  depends_on = [google_project_service.this]
}
