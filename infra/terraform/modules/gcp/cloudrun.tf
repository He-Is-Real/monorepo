# api-public-read on Cloud Run: scales to zero when idle, capped at
# api_public_read_max_instances. Reaches SurrealDB inside GKE through Direct VPC
# egress + the cluster's VPC-scope DNS name (no load balancer).

resource "google_service_account" "api_public_read" {
  project      = var.project_id
  account_id   = "api-public-read"
  display_name = "Cloud Run: api-public-read"
}

resource "google_secret_manager_secret_iam_member" "api_public_read" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.surreal["surreal-api-public-read-password"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.api_public_read.member
}

locals {
  api_public_read_media_env = var.api_public_read_media == null ? {} : {
    BUNNY_STREAM_LIBRARY_ID       = var.api_public_read_media.stream_library_id
    BUNNY_STREAM_CDN_HOST         = var.api_public_read_media.stream_cdn_hostname
    BUNNY_IMAGES_CDN_HOST         = var.api_public_read_media.images_cdn_hostname
    BUNNY_STREAM_TOKEN_KEY_SECRET = var.api_public_read_media.stream_token_key_secret
    BUNNY_IMAGES_TOKEN_KEY_SECRET = var.api_public_read_media.images_token_key_secret
  }
  # Site videos by key (founder-intro → SITE_VIDEO_FOUNDER_INTRO, next-steps →
  # SITE_VIDEO_NEXT_STEPS): GUIDs, not secrets.
  site_video_env = {
    for k, guid in var.site_videos : "SITE_VIDEO_${upper(replace(k, "-", "_"))}" => guid
  }
}

resource "google_cloud_run_v2_service" "api_public_read" {
  project             = var.project_id
  name                = "api-public-read"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.run_deletion_protection
  labels              = local.labels

  # Public = Cloud Run skips the invoker check (D31, 0.9). Not an allUsers binding: the org's
  # domain-restricted sharing refuses those (README "Lessons learned"). Anonymous by design:
  # its database login sees only public tables (D13).
  invoker_iam_disabled = var.api_public_read_public

  template {
    service_account = google_service_account.api_public_read.email

    scaling {
      min_instance_count = 0
      max_instance_count = var.api_public_read_max_instances
    }

    vpc_access {
      network_interfaces {
        network    = google_compute_network.this.id
        subnetwork = google_compute_subnetwork.run.id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = lookup(var.images, "api-public-read", "us-docker.pkg.dev/cloudrun/container/hello")

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
      # Signs in as service:api_public_read through DEFINE ACCESS svc (D13 B).
      env {
        name  = "SURREAL_USER"
        value = "api_public_read"
      }
      env {
        name  = "SURREAL_PASSWORD_SECRET"
        value = "surreal-api-public-read-password"
      }
      # D31: the browser may call it from web's origins only.
      env {
        name  = "CORS_ALLOWED_ORIGINS"
        value = join(",", var.web_origins)
      }
      # The privacy policy and terms PDFs it streams to the browser (read-only; legal_documents.tf).
      env {
        name  = "LEGAL_DOCUMENTS_BUCKET"
        value = google_storage_bucket.legal["documents"].name
      }
      # D52: signs Bunny media links. Secret names, never values: the service reads
      # the keys from Secret Manager at startup (bunny root grants the access).
      dynamic "env" {
        for_each = merge(local.api_public_read_media_env, local.site_video_env)
        content {
          name  = env.key
          value = env.value
        }
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

  depends_on = [google_secret_manager_secret_iam_member.api_public_read]
}

resource "google_cloud_run_v2_service_iam_member" "api_public_read_invokers" {
  for_each = var.api_public_read_public ? toset([]) : toset(var.api_public_read_invokers)

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api_public_read.name
  role     = "roles/run.invoker"
  member   = each.value
}
