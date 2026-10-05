locals {
  labels = {
    app         = "heisreal"
    environment = var.environment
    managed-by  = "terraform"
  }

  # Everything the platform uses. Enabled here so later roots never need
  # service-usage admin rights.
  services = [
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudbilling.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "container.googleapis.com",
    "dns.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",
  ]
}

# The project itself (created by hand on 2026-09-27, adopted via an import block
# in the live root). Billing is linked here; it is never unlinked by automation.
resource "google_project" "this" {
  project_id      = var.project_id
  name            = var.project_name
  org_id          = var.org_id
  billing_account = var.billing_account
  labels          = local.labels
  deletion_policy = "PREVENT"

  lifecycle {
    ignore_changes = [auto_create_network] # creation-time only
  }
}

resource "google_project_service" "this" {
  for_each = toset(local.services)

  project            = google_project.this.project_id
  service            = each.value
  disable_on_destroy = false
}
