# GKE Autopilot: Google runs the nodes; we pay per pod request. Private nodes,
# control plane reachable only via its IAM-protected DNS endpoint.

resource "google_service_account" "gke_nodes" {
  project      = var.project_id
  account_id   = "gke-nodes"
  display_name = "GKE Autopilot nodes"
}

resource "google_project_iam_member" "gke_nodes" {
  project = var.project_id
  role    = "roles/container.defaultNodeServiceAccount"
  member  = google_service_account.gke_nodes.member
}

resource "google_container_cluster" "this" {
  project          = var.project_id
  name             = local.name
  location         = var.region
  enable_autopilot = true

  network    = google_compute_network.this.id
  subnetwork = google_compute_subnetwork.gke.id

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  private_cluster_config {
    enable_private_nodes = true
  }

  # kubectl/Terraform reach the control plane through a Google-fronted DNS
  # name that checks IAM; there is no public IP endpoint.
  control_plane_endpoints_config {
    dns_endpoint_config {
      allow_external_traffic = true
    }
    ip_endpoints_config {
      enabled = false
    }
  }

  # Cluster Service names also resolve across the VPC (Cloud Run -> SurrealDB).
  # Autopilot only accepts this at creation.
  dns_config {
    cluster_dns                   = "CLOUD_DNS"
    cluster_dns_scope             = "CLUSTER_SCOPE"
    additive_vpc_scope_dns_domain = var.cluster_dns_domain
  }

  release_channel {
    channel = "REGULAR"
  }

  cluster_autoscaling {
    auto_provisioning_defaults {
      service_account = google_service_account.gke_nodes.email
      oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    }
  }

  # Only the free system metrics (Joel, 2026-11-07): the extra metric packages Autopilot turns on
  # (kube-state, cAdvisor, kubelet, DCGM) are billed per sample with no free tier and
  # were about £15 of dev's £20 a month, for dashboards nobody uses. Switch a package back on here
  # for a while if a problem needs it. Managed Prometheus stays on (Autopilot requires it); with
  # no packages it collects nothing billable. Autopilot keeps its network (datapath) metrics on
  # whatever we ask (an update to false is accepted but not applied), so they aren't set here.
  monitoring_config {
    enable_components = ["SYSTEM_COMPONENTS"]
    managed_prometheus {
      enabled = true
    }
  }

  resource_labels     = local.labels
  deletion_protection = var.deletion_protection

  depends_on = [google_project_iam_member.gke_nodes]
}
