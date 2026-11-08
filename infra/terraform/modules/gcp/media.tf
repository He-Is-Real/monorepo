# Media ready (M2 plan item 13; D78, D126, D129; media-worker-final.html): how an uploaded video or
# audio file becomes "ready". Plan: project/context/research/m2-media-ready-plan.html.
#
#   Bunny ──"finished"/"failed"/"deleted"──▶ api-user POST /v1/webhooks/bunny
#   api-user ──▶ mediaJob table (written first), then media-jobs (topic), in order per story
#   media-jobs ──pull──▶ the media worker (Dapr, Joel's machine, outbound only; apps/media-worker)
#   media worker ──direct call, as media-worker──▶ result writer (Cloud Run, apps/workflow)
#   result writer ──workflow login──▶ SurrealDB: the storyFile row and the job's end, one transaction
#   result writer ──▶ media-jobs: the render and check jobs it opens itself (J1 check e)
#   result writer ──library key──▶ Bunny: an audio story's picture video, a video's picture (K1, A)
# The subscription delivers in order per ordering key, which is the story's id (Joel, 2026-11-06,
# video-bundle-rethink part A). No answers queue and no dead letters (Joel, 2026-11-07, J4/J5): the
# job table records failures, and a job that fails 5 times gives up there.
#
# Everything stays in London: the topic stores messages in europe-west2 only, enforced in transit
# too (the UK guard, tools/scripts/tf-location-check.sh, checks the storage policy), and the
# result writer runs there. Jobs carry ids only, never a person's name or story text.
#
# Least privilege:
#   media-worker   the worker's identity (D126: Joel's gcloud login acting as it; no key file).
#                  Pulls media-jobs through its subscription, calls the result writer (run.invoker
#                  on it only) and (the bunny root) reads Bunny's read-only library key. It reads
#                  a picture video's sound through 2-minute links to one file the result writer
#                  signs (R3). No database password, no key that can change anything at Bunny
#                  (K1), no key to Bunny's storage, nothing else.
#   workflow       the result writer's runtime identity: reads its own database password and signs
#                  in as service:workflow (docs/db-permissions.md); publishes to media-jobs (the
#                  jobs it opens); and (the bunny root's result_writer_readers) reads Bunny's
#                  library key, the images token key and the sound zone's token key: it makes
#                  picture videos, signs the worker's one-hour pass and its sound links, and sets
#                  a video's picture (Joel, 2026-11-07, K1; 2026-11-08, R3).
#   api-user       may publish to media-jobs (and to no other topic).
#   housekeeping   may publish to media-jobs too: the 18:00 resend (housekeeping.tf).
# The result writer takes traffic from the internet (the worker is off Google Cloud), but Cloud Run
# refuses every request without a Google ID token of a run.invoker (media-worker only) before it
# reaches our code.

locals {
  media_ready = var.media_ready != null
  # Pub/Sub's own maximum (31 days): how long jobs wait while Joel's machine is off (the plan's
  # "Your PC is off for days"). A job older than that is still in the job table, and the nightly
  # resend sends it again.
  media_retention = "2678400s"
  media_topics    = local.media_ready ? toset(["media-jobs"]) : toset([])
}

resource "google_pubsub_topic" "media" {
  for_each = local.media_topics

  project = var.project_id
  name    = each.value
  labels  = merge(local.labels, { component = "media-ready" })

  message_retention_duration = local.media_retention

  message_storage_policy {
    allowed_persistence_regions = [var.region] # London only (UK data)
    enforce_in_transit          = true
  }
}

# --- The worker's jobs: a pull subscription that never expires ---------------------------------
# Google deletes a subscription nobody pulled from for 31 days by default: exactly a long holiday
# with Joel's machine off. ttl = "" means never.
# Named as Dapr's GCP Pub/Sub component names it, "<consumerID>-<topic>" (consumerID media-worker,
# apps/media-worker/dapr/components/media-jobs.yaml): the component can't take any other name, and
# it may not create one itself (disableEntityManagement).
resource "google_pubsub_subscription" "media_worker" {
  count = local.media_ready ? 1 : 0

  project = var.project_id
  name    = "media-worker-media-jobs"
  topic   = google_pubsub_topic.media["media-jobs"].id
  labels  = merge(local.labels, { component = "media-ready" })

  ack_deadline_seconds       = 60 # one look at Bunny, then the call to the writer
  message_retention_duration = local.media_retention
  retain_acked_messages      = false
  enable_message_ordering    = true # per story (the ordering key)

  expiration_policy {
    ttl = ""
  }
  # The worker doesn't mark a job taken (Bunny or the writer unreachable, or under 5 failures):
  # Pub/Sub redelivers it, backing off 10 seconds up to 10 minutes. No dead-letter policy (J4).
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

# --- The worker's identity (D126) -----------------------------------------------------------------
resource "google_service_account" "media_worker" {
  count = local.media_ready ? 1 : 0

  project      = var.project_id
  account_id   = "media-worker"
  display_name = "Media worker (Dapr, off Google Cloud): pulls media-jobs, calls the result writer"
}

resource "google_pubsub_subscription_iam_member" "media_worker" {
  count = local.media_ready ? 1 : 0

  project      = var.project_id
  subscription = google_pubsub_subscription.media_worker[0].name
  role         = "roles/pubsub.subscriber"
  member       = google_service_account.media_worker[0].member
}

# D126: the named people (Joel) may act as the worker with their own gcloud login, so no key file
# exists. On church hardware this becomes Workload Identity Federation (a decision for then).
resource "google_service_account_iam_member" "media_worker_impersonators" {
  for_each = local.media_ready ? toset(var.media_ready.worker_impersonators) : toset([])

  service_account_id = google_service_account.media_worker[0].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = each.value
}

# --- api-user queues jobs (POST /v1/webhooks/bunny) -----------------------------------------------
resource "google_pubsub_topic_iam_member" "api_user_media_jobs" {
  count = local.media_ready ? 1 : 0

  project = var.project_id
  topic   = google_pubsub_topic.media["media-jobs"].name
  role    = "roles/pubsub.publisher"
  member  = google_service_account.signed_in_api["api-user"].member
}

# --- The result writer (apps/workflow) ------------------------------------------------------------
# It opens render and check jobs itself and sends them (Joel, 2026-11-07: media-job-table.html J1
# check e, "the writer gets permission to send to the job queue").
resource "google_pubsub_topic_iam_member" "result_writer_media_jobs" {
  count = local.media_ready ? 1 : 0

  project = var.project_id
  topic   = google_pubsub_topic.media["media-jobs"].name
  role    = "roles/pubsub.publisher"
  member  = google_service_account.result_writer[0].member
}

resource "google_service_account" "result_writer" {
  count = local.media_ready ? 1 : 0

  project      = var.project_id
  account_id   = "workflow"
  display_name = "Cloud Run: workflow (media result writer)"
}

resource "google_secret_manager_secret_iam_member" "result_writer" {
  count = local.media_ready ? 1 : 0

  project   = var.project_id
  secret_id = google_secret_manager_secret.surreal["surreal-workflow-password"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.result_writer[0].member
}

resource "google_cloud_run_v2_service" "result_writer" {
  count = local.media_ready ? 1 : 0

  project             = var.project_id
  name                = "workflow"
  location            = var.region
  deletion_protection = var.run_deletion_protection
  labels              = local.labels

  # The worker calls it from Joel's machine (J5), so it takes traffic from the internet; Cloud Run
  # refuses any request without a Google ID token of a run.invoker (media-worker only) before it
  # reaches our code.
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = false

  template {
    service_account = google_service_account.result_writer[0].email

    scaling {
      min_instance_count = 0
      max_instance_count = 1 # a few answers a day; scale to zero
    }

    vpc_access {
      network_interfaces {
        network    = google_compute_network.this.id
        subnetwork = google_compute_subnetwork.run.id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = lookup(var.images, "workflow", "us-docker.pkg.dev/cloudrun/container/hello")

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
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
      # Signs in as service:workflow, the only login that may set a file's processing (A2).
      env {
        name  = "SURREAL_USER"
        value = "workflow"
      }
      env {
        name  = "SURREAL_PASSWORD_SECRET"
        value = "surreal-workflow-password"
      }
      # The jobs it opens go here (a name; its identity may publish to it).
      env {
        name  = "MEDIA_JOBS_TOPIC"
        value = google_pubsub_topic.media["media-jobs"].name
      }
      # Bunny (K1, part A): the Stream library, the images CDN, and the secrets of the library key
      # and the images token key (names, never values; the bunny root's result_writer_readers
      # grant lets it read them, when it first needs them).
      env {
        name  = "BUNNY_STREAM_LIBRARY_ID"
        value = var.api_public_read_media.stream_library_id
      }
      env {
        name  = "BUNNY_STREAM_API_KEY_SECRET"
        value = "bunny-stream-api-key"
      }
      env {
        name  = "BUNNY_IMAGES_CDN_HOST"
        value = var.api_public_read_media.images_cdn_hostname
      }
      env {
        name  = "BUNNY_IMAGES_TOKEN_KEY_SECRET"
        value = var.api_public_read_media.images_token_key_secret
      }
      # R3 (Joel, 2026-11-08): the sound zone and its token key's secret (the bunny root's
      # result_writer_readers grant), for the worker's 2-minute link to one copy of a sound.
      env {
        name  = "BUNNY_SOUND_CDN_HOST"
        value = coalesce(var.media_ready.sound_cdn_hostname, "heisreal-${var.environment}-sound.b-cdn.net")
      }
      env {
        name  = "BUNNY_SOUND_TOKEN_KEY_SECRET"
        value = var.media_ready.sound_token_key_secret
      }

      startup_probe {
        tcp_socket {
          port = 8080
        }
        period_seconds    = 5
        failure_threshold = 6
      }
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.result_writer]
}

# Only the worker may call the result writer (J5).
resource "google_cloud_run_v2_service_iam_member" "result_writer_worker" {
  count = local.media_ready ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.result_writer[0].name
  role     = "roles/run.invoker"
  member   = google_service_account.media_worker[0].member
}
