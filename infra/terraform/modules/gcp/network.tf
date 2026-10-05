# One private network. Private Google Access lets nodes and Cloud Run reach
# Google APIs (Secret Manager, Artifact Registry) without public IPs or NAT.

resource "google_compute_network" "this" {
  project                 = var.project_id
  name                    = local.name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "gke" {
  project                  = var.project_id
  name                     = "${local.name}-gke"
  region                   = var.region
  network                  = google_compute_network.this.id
  ip_cidr_range            = var.network_cidrs.gke
  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.network_cidrs.pods
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.network_cidrs.services
  }
}

# Cloud Run instances get IPs here (Direct VPC egress).
resource "google_compute_subnetwork" "run" {
  project                  = var.project_id
  name                     = "${local.name}-run"
  region                   = var.region
  network                  = google_compute_network.this.id
  ip_cidr_range            = var.network_cidrs.run
  private_ip_google_access = true
}

# Cloud Run -> SurrealDB pods on 8000 only. Kubernetes NetworkPolicy narrows
# this further to the SurrealDB pod itself.
resource "google_compute_firewall" "run_to_surrealdb" {
  project   = var.project_id
  name      = "${local.name}-run-to-surrealdb"
  network   = google_compute_network.this.id
  direction = "INGRESS"

  source_ranges           = [var.network_cidrs.run]
  target_service_accounts = [google_service_account.gke_nodes.email]

  allow {
    protocol = "tcp"
    ports    = ["8000"]
  }
}
