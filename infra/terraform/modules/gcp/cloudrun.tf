# api-read on Cloud Run: scales to zero when idle, capped at
# api_read_max_instances. Reaches SurrealDB inside GKE through Direct VPC
# egress + the cluster's VPC-scope DNS name (no load balancer).

resource "google_service_account" "api_read" {
  project      = var.project_id
  account_id   = "api-read"
  display_name = "Cloud Run: api-read"
}

resource "google_secret_manager_secret_iam_member" "api_read" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.surreal["surreal-api-read-password"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.api_read.member
}

resource "google_cloud_run_v2_service" "api_read" {
  project             = var.project_id
  name                = "api-read"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.deletion_protection
  labels              = local.labels

  template {
    service_account = google_service_account.api_read.email

    scaling {
      min_instance_count = 0
      max_instance_count = var.api_read_max_instances
    }

    vpc_access {
      network_interfaces {
        network    = google_compute_network.this.id
        subnetwork = google_compute_subnetwork.run.id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = lookup(var.images, "api-read", "us-docker.pkg.dev/cloudrun/container/hello")

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true # only billed while handling requests
      }

      env {
        name  = "GCP_PROJECT"
        value = var.project_id
      }
      env {
        name  = "SURREAL_URL"
        value = "ws://${local.surrealdb_host}:8000"
      }
      env {
        name  = "SURREAL_NAMESPACE"
        value = "heisreal"
      }
      env {
        name  = "SURREAL_DATABASE"
        value = "main"
      }
      env {
        name  = "SURREAL_USER"
        value = "api_read"
      }
      env {
        name  = "SURREAL_PASSWORD_SECRET"
        value = "surreal-api-read-password"
      }

      # Readiness to receive traffic = the port is open. /health reports the
      # database state but must not make Cloud Run restart the container.
      startup_probe {
        tcp_socket {
          port = 8080
        }
        period_seconds    = 5
        failure_threshold = 6
      }
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.api_read]
}

resource "google_cloud_run_v2_service_iam_member" "api_read_public" {
  count = var.api_read_public ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api_read.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "api_read_invokers" {
  for_each = var.api_read_public ? toset([]) : toset(var.api_read_invokers)

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api_read.name
  role     = "roles/run.invoker"
  member   = each.value
}
