# Housekeeping (M2; Joel, 2026-10-30): one nightly Cloud Run Job (apps/housekeeping) that runs
# a list of small chores, started by Cloud Scheduler. Both in London (var.region), like
# everything here. Chores: D71's abandoned drafts (untouched for 6 months) and orphaned Bunny
# Stream videos; and after erasure (M2 plan PR 11), erasure requests api-user didn't finish and
# the queued Bunny, picture and Clerk deletions it couldn't do (an abandoned draft's pictures are
# queued too, M2 plan PR 10). Orphaned images join the list later. Media jobs (Joel, 2026-11-07,
# media-worker-final.html): the nightly run deletes ended jobs 30 days old, and a second trigger
# at 18:00 London time (when Joel's machine is on to take them) runs the same Job with only the
# media resend: unfinished jobs last sent over 12 hours ago go to media-jobs again.
#
# Least privilege:
#   housekeeping            the Job's runtime identity. Reads its own database password and,
#                           through the bunny root's stream_key_readers grant, the Stream library
#                           key, and Clerk's secret key (secrets.tf; only to delete the Clerk
#                           account of someone erased: D39, D81), and through the bunny root's
#                           storage_password_readers grant the images zone's password (only to
#                           delete a gone story's pictures: erasure, abandoned drafts). Signs in as
#                           service:housekeeping, whose table permissions allow reading stories'
#                           ids, status, dates and media ids (never their words), deleting a
#                           draft untouched for 6 months, and seeing, retrying and deleting
#                           erasure requests and queued deletions, nothing else
#                           (docs/db-permissions.md). With media ready, it may also publish to
#                           media-jobs (the resend), and its login reads, resends and deletes
#                           ended media jobs.
#   housekeeping-scheduler  Cloud Scheduler's identity for the nightly run. May start this one Job
#                           (run.invoker on the Job only), with no overrides; nothing else.
#   media-resend-scheduler  Cloud Scheduler's identity for the 18:00 media resend. May start this
#                           one Job with overrides (the resend's HOUSEKEEPING_CHORES), on the Job
#                           only; nothing else. Kept apart so the nightly trigger can't override.
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

# Clerk's secret key, only to retry deleting an erased person's Clerk account (D39, D81: account
# deletion is one of the server jobs that may use it). No other Clerk secret.
resource "google_secret_manager_secret_iam_member" "housekeeping_clerk" {
  count = var.housekeeping == null ? 0 : 1

  project   = var.project_id
  secret_id = google_secret_manager_secret.clerk_secret_key.secret_id
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
        # Clerk's secret key's secret (a name, never the value): queued Clerk account deletions.
        env {
          name  = "CLERK_SECRET_KEY_SECRET"
          value = google_secret_manager_secret.clerk_secret_key.secret_id
        }
        # The images zone api-user's pictures go to (api_user_image_uploads), and its password's
        # secret (a name, never the value; the bunny root's storage_password_readers grant):
        # queued picture deletions, a gone story's folder. Without it they wait in the queue.
        dynamic "env" {
          for_each = var.api_user_image_uploads == null ? {} : {
            BUNNY_STORAGE_ZONE            = var.api_user_image_uploads.storage_zone
            BUNNY_STORAGE_S3_HOST         = var.api_user_image_uploads.s3_host
            BUNNY_STORAGE_PASSWORD_SECRET = var.api_user_image_uploads.password_secret
          }
          content {
            name  = env.key
            value = env.value
          }
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
        # The nightly chores; the 18:00 trigger overrides this with media-resend (below).
        env {
          name  = "HOUSEKEEPING_CHORES"
          value = "nightly"
        }
        # The topic the media resend sends to (a name; the Job's identity may publish to it).
        dynamic "env" {
          for_each = local.media_ready ? { MEDIA_JOBS_TOPIC = google_pubsub_topic.media["media-jobs"].name } : {}
          content {
            name  = env.key
            value = env.value
          }
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

  depends_on = [
    google_secret_manager_secret_iam_member.housekeeping,
    google_secret_manager_secret_iam_member.housekeeping_clerk,
  ]
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

# --- The 18:00 media resend (Joel, 2026-11-07) -------------------------------------------------
# "do the resend at 18:00 UK local time, as that is when my pc is on and will have a worker
# available". Only with media ready (there is no queue to resend to without it).
locals {
  media_resend = var.housekeeping != null && local.media_ready
}

# The resend publishes to media-jobs, and to no other topic.
resource "google_pubsub_topic_iam_member" "housekeeping_media_jobs" {
  count = local.media_resend ? 1 : 0

  project = var.project_id
  topic   = google_pubsub_topic.media["media-jobs"].name
  role    = "roles/pubsub.publisher"
  member  = google_service_account.housekeeping[0].member
}

resource "google_service_account" "media_resend_scheduler" {
  count = local.media_resend ? 1 : 0

  project      = var.project_id
  account_id   = "media-resend-scheduler"
  display_name = "Cloud Scheduler: starts the housekeeping Job's 18:00 media resend"
}

# run.jobs.runWithOverrides on this Job only: the resend run names its chores in an override.
resource "google_cloud_run_v2_job_iam_member" "media_resend_scheduler" {
  count = local.media_resend ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.housekeeping[0].name
  role     = "roles/run.jobsExecutorWithOverrides"
  member   = google_service_account.media_resend_scheduler[0].member
}

# The same Job, with HOUSEKEEPING_CHORES=media-resend: only the resend runs, never the nightly
# chores (and the nightly run never resends).
resource "google_cloud_scheduler_job" "media_resend" {
  count = local.media_resend ? 1 : 0

  project          = var.project_id
  name             = "housekeeping-media-resend"
  region           = var.region
  description      = "Starts the housekeeping Cloud Run Job with only the media resend."
  schedule         = var.housekeeping.media_resend_schedule
  time_zone        = "Europe/London"
  attempt_deadline = "60s" # the call only starts the Job; it doesn't wait for it

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.housekeeping[0].name}:run"
    headers     = { "Content-Type" = "application/json" }
    body = base64encode(jsonencode({
      overrides = {
        containerOverrides = [{
          env = [{ name = "HOUSEKEEPING_CHORES", value = "media-resend" }]
        }]
      }
    }))

    oauth_token {
      service_account_email = google_service_account.media_resend_scheduler[0].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.media_resend_scheduler]
}
