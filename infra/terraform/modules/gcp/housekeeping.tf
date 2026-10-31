# Housekeeping (M2; Joel, 2026-10-30): one nightly Cloud Run Job (apps/housekeeping) that runs
# a list of small chores, started by Cloud Scheduler. Both in London (var.region), like
# everything here. Chores: D71's abandoned drafts (untouched for 6 months) and orphaned Bunny
# Stream videos; images orphans and post-erasure clean-up join the same list later.
#
# Least privilege:
#   housekeeping            the Job's runtime identity. Reads its own database password and,
#                           through the bunny root's stream_key_readers grant, the Stream library
#                           key. Signs in as service:housekeeping, whose table permissions allow
#                           reading stories' ids, status, dates and media ids (never their words)
#                           and deleting a draft untouched for 6 months, nothing else
#                           (docs/db-permissions.md).
#   housekeeping-scheduler  Cloud Scheduler's identity. May start this one Job (run.invoker on
#                           the Job only), with no overrides; nothing else.
# Like dev-seed, it reaches SurrealDB over Direct VPC egress and the cluster's VPC-scope DNS name.

resource "google_service_account" "housekeeping" {
  count = var.housekeeping == null ? 0 : 1

  project      = var.project_id
  account_id   = "housekeeping"
  display_name = "Cloud Run Job: housekeeping (nightly chores)"
}

resource "google_secret_manager_secret_iam_member" "housekeeping" {
  count = var.housekeeping == null ? 0 : 1

  project   = var.project_id
  secret_id = google_secret_manager_secret.surreal["surreal-housekeeping-password"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.housekeeping[0].member
}

resource "google_cloud_run_v2_job" "housekeeping" {
  count = var.housekeeping == null ? 0 : 1

  project             = var.project_id
  name                = "housekeeping"
  location            = var.region
  deletion_protection = false # holds no data; re-created from here
  labels              = local.labels

  template {
    task_count  = 1
    parallelism = 1

    template {
      service_account = google_service_account.housekeeping[0].email
      max_retries     = 0 # idempotent, but a failure needs a look; the next night runs anyway
      timeout         = "900s"

      vpc_access {
        network_interfaces {
          network    = google_compute_network.this.id
          subnetwork = google_compute_subnetwork.run.id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      containers {
        # Until Release Images has built housekeeping and images.auto.tfvars selects it: Google's
        # sample job, which prints a line and exits.
        image = lookup(var.images, "housekeeping", "us-docker.pkg.dev/cloudrun/container/job:latest")

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
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
        # Signs in as service:housekeeping through DEFINE ACCESS svc (D13 B).
        env {
          name  = "SURREAL_USER"
          value = "housekeeping"
        }
        env {
          name  = "SURREAL_PASSWORD_SECRET"
          value = "surreal-housekeeping-password"
        }
        # The stories' Stream library and its key's secret (a name, never the value).
        env {
          name  = "BUNNY_STREAM_LIBRARY_ID"
          value = var.api_public_read_media.stream_library_id
        }
        env {
          name  = "BUNNY_STREAM_API_KEY_SECRET"
          value = "bunny-stream-api-key"
        }
        # true: only logs what it would delete.
        env {
          name  = "HOUSEKEEPING_DRY_RUN"
          value = tostring(var.housekeeping.dry_run)
        }
        # Each chore deletes at most this many per run; the rest wait for the next night.
        env {
          name  = "HOUSEKEEPING_MAX_DELETIONS"
          value = tostring(var.housekeeping.max_deletions)
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = var.api_public_read_media != null
      error_message = "housekeeping needs the Stream library (api_public_read_media.stream_library_id)."
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.housekeeping]
}

resource "google_service_account" "housekeeping_scheduler" {
  count = var.housekeeping == null ? 0 : 1

  project      = var.project_id
  account_id   = "housekeeping-scheduler"
  display_name = "Cloud Scheduler: starts the housekeeping Job"
}

# run.invoker on this Job only: run.jobs.run without overrides (the Job's settings stay as here).
resource "google_cloud_run_v2_job_iam_member" "housekeeping_scheduler" {
  count = var.housekeeping == null ? 0 : 1

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.housekeeping[0].name
  role     = "roles/run.invoker"
  member   = google_service_account.housekeeping_scheduler[0].member
}

# Calls the Cloud Run Admin API's jobs.run. A Google API takes an OAuth access token, not an
# OIDC ID token (OIDC is for calling a Cloud Run service's own URL).
resource "google_cloud_scheduler_job" "housekeeping" {
  count = var.housekeeping == null ? 0 : 1

  project          = var.project_id
  name             = "housekeeping"
  region           = var.region
  description      = "Starts the nightly housekeeping Cloud Run Job."
  schedule         = var.housekeeping.schedule
  time_zone        = "Europe/London"
  attempt_deadline = "60s" # the call only starts the Job; it doesn't wait for it

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.housekeeping[0].name}:run"

    oauth_token {
      service_account_email = google_service_account.housekeeping_scheduler[0].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.housekeeping_scheduler]
}
