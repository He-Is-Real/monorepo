# web (Next.js, apps/web) on Cloud Run (D4): same image pattern and scaling as
# the APIs. It server-renders from api-public-read only (D32), so it has no VPC
# access, no database login and no secrets: its service account holds no roles.
# Private in dev until the walking-skeleton page (0.9) makes it public together
# with api-public-read (D31), like decision 8.

resource "google_service_account" "web" {
  project      = var.project_id
  account_id   = "run-web" # account IDs need 6+ characters
  display_name = "Cloud Run: web"
}

resource "google_cloud_run_v2_service" "web" {
  project             = var.project_id
  name                = "web"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.run_deletion_protection
  labels              = local.labels

  # Public = Cloud Run skips the invoker check. Not an allUsers binding: the
  # org's domain-restricted sharing refuses those (README "Lessons learned").
  invoker_iam_disabled = var.web_public

  template {
    service_account = google_service_account.web.email

    scaling {
      min_instance_count = 0
      max_instance_count = var.web_max_instances
    }

    containers {
      image = lookup(var.images, "web", "us-docker.pkg.dev/cloudrun/container/hello")

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true # only billed while handling requests
      }

      # Read at request time by apps/web/src/lib/config.ts. Server-side only:
      # the browser's own calls to the APIs (D31) arrive with 0.9.
      env {
        name  = "API_PUBLIC_READ_URL"
        value = google_cloud_run_v2_service.api_public_read.uri
      }

      # Public (D32): read at request time and handed to Clerk in the browser,
      # which is the only place Clerk runs. web's server holds no Clerk secret.
      env {
        name  = "CLERK_PUBLISHABLE_KEY"
        value = var.clerk_publishable_key
      }

      # As for the APIs: ready = the port is open. GET /health exists for
      # manual checks.
      startup_probe {
        tcp_socket {
          port = 8080
        }
        period_seconds    = 5
        failure_threshold = 6
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "web_invokers" {
  for_each = var.web_public ? toset([]) : toset(var.web_invokers)

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = each.value
}
