# api-user and api-admin on Cloud Run (M2 prerequisite): the signed-in person's own API and the
# moderation API. Same shape as api-public-read (scale to zero, capped, Direct VPC egress to
# SurrealDB on GKE), but every route needs a Clerk session token, verified in the app against
# the pinned key (task 0.5, D1, D21). Each has its own runtime service account, which may read
# only its own database password, and signs in as its own service record (D13 B). Verification
# is offline; only api-user reads Clerk's secret key, for erasure (secrets.tf).

locals {
  signed_in_apis = {
    "api-user" = {
      db_user       = "api_user"
      password_name = "surreal-api-user-password"
    }
    "api-admin" = {
      db_user       = "api_admin"
      password_name = "surreal-api-admin-password"
    }
  }
}

resource "google_service_account" "signed_in_api" {
  for_each = local.signed_in_apis

  project      = var.project_id
  account_id   = each.key
  display_name = "Cloud Run: ${each.key}"
}

resource "google_secret_manager_secret_iam_member" "signed_in_api" {
  for_each = local.signed_in_apis

  project   = var.project_id
  secret_id = google_secret_manager_secret.surreal[each.value.password_name].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.signed_in_api[each.key].member
}

resource "google_cloud_run_v2_service" "signed_in_api" {
  for_each = local.signed_in_apis

  project             = var.project_id
  name                = each.key
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.run_deletion_protection
  labels              = local.labels

  # Public = Cloud Run skips the invoker check, as for api-public-read (not an allUsers binding:
  # the org's domain-restricted sharing refuses those). The browser calls these directly (D31),
  # so Cloud Run's own IAM can't be the gate; the app refuses any request without a valid Clerk
  # session token, except /health.
  invoker_iam_disabled = var.signed_in_apis_public

  template {
    # A new revision whenever the run subnet changes: a revision that failed to start for lack
    # of addresses (2026-10-31) is retried on the new subnet instead of left failed.
    labels = { run-subnet = replace(var.network_cidrs.run, "/[./]/", "-") }

    service_account = google_service_account.signed_in_api[each.key].email

    scaling {
      min_instance_count = 0
      max_instance_count = var.signed_in_apis_max_instances
    }

    vpc_access {
      network_interfaces {
        network    = google_compute_network.this.id
        subnetwork = google_compute_subnetwork.run.id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = lookup(var.images, each.key, "us-docker.pkg.dev/cloudrun/container/hello")

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
      # Signs in as service:<db_user> through DEFINE ACCESS svc (D13 B).
      env {
        name  = "SURREAL_USER"
        value = each.value.db_user
      }
      env {
        name  = "SURREAL_PASSWORD_SECRET"
        value = each.value.password_name
      }
      # Task 0.5: Clerk session tokens, verified offline. All public values.
      env {
        name  = "CLERK_ISSUER"
        value = var.clerk_issuer
      }
      # One line with \n escapes (libs/auth accepts both forms).
      env {
        name  = "CLERK_JWT_PUBLIC_KEY"
        value = replace(trimspace(var.clerk_jwt_public_key), "\n", "\\n")
      }
      # The token's azp must be one of web's origins, the only page that signs people in.
      env {
        name  = "CLERK_AUTHORIZED_PARTIES"
        value = join(",", var.web_origins)
      }
      # D31: the browser may call it from web's origins only.
      env {
        name  = "CORS_ALLOWED_ORIGINS"
        value = join(",", var.web_origins)
      }
      # Hearts (M2): api-user signs the media links on favourites' cards like api-public-read
      # (D52). Uploads (M2 plan PR 7): it creates and signs Stream uploads with the library key;
      # images (PR 10): it signs S3 presigned PUTs with the images zone's password.
      # Erasure (PR 11): Clerk's secret key deletes the person at Clerk, and the webhook's signing
      # secret verifies user.deleted; both are read when first needed, so a secret without a
      # version yet turns off only that. Secret names, never values; secrets.tf (Clerk) and the
      # bunny root grant the access.
      dynamic "env" {
        for_each = each.key != "api-user" ? {} : merge(
          {
            CLERK_SECRET_KEY_SECRET     = google_secret_manager_secret.clerk_secret_key.secret_id
            CLERK_WEBHOOK_SECRET_SECRET = google_secret_manager_secret.clerk_webhook_signing_secret.secret_id
          },
          var.api_user_media_signing ? local.api_public_read_media_env : {},
          var.api_user_uploads ? {
            BUNNY_STREAM_LIBRARY_ID     = var.api_public_read_media.stream_library_id
            BUNNY_STREAM_API_KEY_SECRET = "bunny-stream-api-key"
          } : {},
          var.api_user_image_uploads == null ? {} : {
            BUNNY_STORAGE_ZONE            = var.api_user_image_uploads.storage_zone
            BUNNY_STORAGE_S3_HOST         = var.api_user_image_uploads.s3_host
            BUNNY_STORAGE_S3_REGION       = var.api_user_image_uploads.s3_region
            BUNNY_STORAGE_PASSWORD_SECRET = var.api_user_image_uploads.password_secret
          },
        )
        content {
          name  = env.key
          value = env.value
        }
      }

      # As for api-public-read: ready = the port is open, which happens only after the app has
      # connected to the database and passed its start-up checks (roles, consent policy).
      startup_probe {
        tcp_socket {
          port = 8080
        }
        period_seconds    = 5
        failure_threshold = 6
      }
    }
  }

  lifecycle {
    # Without these the app refuses to start, so the apply would fail on the revision instead.
    precondition {
      condition     = length(var.web_origins) > 0
      error_message = "${each.key} needs web_origins: its Clerk authorized parties and CORS origins."
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.signed_in_api,
    google_secret_manager_secret_iam_member.api_user_clerk,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "signed_in_api_invokers" {
  for_each = var.signed_in_apis_public ? {} : {
    for pair in setproduct(keys(local.signed_in_apis), var.signed_in_apis_invokers) :
    "${pair[0]} ${pair[1]}" => { service = pair[0], member = pair[1] }
  }

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.signed_in_api[each.value.service].name
  role     = "roles/run.invoker"
  member   = each.value.member
}
