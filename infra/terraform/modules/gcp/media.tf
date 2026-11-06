# Media ready (M2 plan item 13, pieces 1–3; D78, D126, D129): how an uploaded video or audio file
# becomes "ready". Plan: project/context/research/m2-media-ready-plan.html.
#
#   Bunny ──"finished"/"failed"──▶ api-user POST /v1/webhooks/bunny ──▶ media-jobs (topic)
#   media-jobs ──pull──▶ the media worker (Dapr, Joel's machine, outbound only; piece 4)
#   media worker ──▶ media-results (topic, in order per story) ──push──▶ result writer (Cloud Run)
# Both subscriptions deliver in order per ordering key, which is the story's id (Joel, 2026-11-06,
# video-bundle-rethink part A: a story's jobs, including the later "publish" jobs, run in order).
#   result writer ──workflow login──▶ SurrealDB: the storyFile row of that Bunny video
#
# Everything stays in London: each topic stores messages in europe-west2 only, enforced in transit
# too (the UK guard, tools/scripts/tf-location-check.sh, checks the storage policy). Jobs and
# results carry ids and facts (size, length), never a person's name or story text.
#
# Least privilege:
#   media-worker         the worker's identity (D126: Joel's gcloud login acting as it; no key
#                        file). Pulls media-jobs through its subscription, publishes media-results,
#                        and (the bunny root's readonly_key_readers) reads Bunny's read-only library
#                        key. No database password, no other Bunny key, nothing else.
#   workflow             the result writer's runtime identity: reads its own database password and
#                        signs in as service:workflow (docs/db-permissions.md). Nothing else.
#   media-results-push   the identity Pub/Sub's push signs its OIDC token as: run.invoker on the
#                        result writer only. The result writer takes internal traffic only (Pub/Sub
#                        push from this project) and Cloud Run checks the token, so it has no public
#                        address and nobody else can call it.
#   api-user             may publish to media-jobs (and to no other topic).
#   Pub/Sub's own agent  moves a message that failed 5 times to media-dead-letters.

locals {
  media_ready = var.media_ready != null
  # Pub/Sub's own maximum (31 days): how long jobs wait while Joel's machine is off (the plan's
  # "Your PC is off for days"). Unacknowledged messages and dead letters alike.
  media_retention = "2678400s"
  media_topics    = local.media_ready ? toset(["media-jobs", "media-results", "media-dead-letters"]) : toset([])
}

data "google_project" "media" {
  count      = local.media_ready ? 1 : 0
  project_id = var.project_id
}

locals {
  pubsub_agent = local.media_ready ? "serviceAccount:service-${data.google_project.media[0].number}@gcp-sa-pubsub.iam.gserviceaccount.com" : null
}

resource "google_pubsub_topic" "media" {
  for_each = local.media_topics

  project = var.project_id
  name    = each.value
  labels  = merge(local.labels, { component = "media-ready" })

  # A copy of every message for the retention period, so a subscription that lost one can seek
  # back (the runbook's "send it again").
  message_retention_duration = local.media_retention

  message_storage_policy {
    allowed_persistence_regions = [var.region] # London only (UK data)
    enforce_in_transit          = true
  }
}

# --- The worker's jobs: a pull subscription that never expires ---------------------------------
# Google deletes a subscription nobody pulled from for 31 days by default: exactly a long holiday
# with Joel's machine off. ttl = "" means never.
resource "google_pubsub_subscription" "media_worker" {
  count = local.media_ready ? 1 : 0

  project = var.project_id
  name    = "media-worker"
  topic   = google_pubsub_topic.media["media-jobs"].id
  labels  = merge(local.labels, { component = "media-ready" })

  ack_deadline_seconds       = 60 # one look at Bunny, then the answer
  message_retention_duration = local.media_retention
  retain_acked_messages      = false
  enable_message_ordering    = true # per story (the ordering key)

  expiration_policy {
    ttl = ""
  }
  # Bunny down: the worker says "try later" and Pub/Sub backs off, 10 seconds up to 10 minutes.
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.media["media-dead-letters"].id
    max_delivery_attempts = 5
  }
}

# --- The answers: pushed to the result writer, in order per story ------------------------------
# The worker publishes each answer with the story's id as its ordering key, so an older "failed"
# can't land after a newer "ready".
resource "google_pubsub_subscription" "media_results" {
  count = local.media_ready ? 1 : 0

  project = var.project_id
  name    = "media-results-writer"
  topic   = google_pubsub_topic.media["media-results"].id
  labels  = merge(local.labels, { component = "media-ready" })

  ack_deadline_seconds       = 60
  message_retention_duration = local.media_retention
  enable_message_ordering    = true

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.result_writer[0].uri}/v1/media-results"
    oidc_token {
      service_account_email = google_service_account.media_results_push[0].email
      audience              = google_cloud_run_v2_service.result_writer[0].uri
    }
  }
  expiration_policy {
    ttl = ""
  }
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.media["media-dead-letters"].id
    max_delivery_attempts = 5
  }
}

# --- Dead letters: kept 31 days for a developer to read and send again (docs/media-runbook.md) --
resource "google_pubsub_subscription" "media_dead_letters" {
  count = local.media_ready ? 1 : 0

  project = var.project_id
  name    = "media-dead-letters"
  topic   = google_pubsub_topic.media["media-dead-letters"].id
  labels  = merge(local.labels, { component = "media-ready" })

  ack_deadline_seconds       = 60
  message_retention_duration = local.media_retention

  expiration_policy {
    ttl = ""
  }
}

# Pub/Sub's own agent forwards a message that failed 5 times: it must publish to the dead-letter
# topic and acknowledge on the subscriptions it came from.
resource "google_pubsub_topic_iam_member" "dead_letter_publisher" {
  count = local.media_ready ? 1 : 0

  project = var.project_id
  topic   = google_pubsub_topic.media["media-dead-letters"].name
  role    = "roles/pubsub.publisher"
  member  = local.pubsub_agent
}

resource "google_pubsub_subscription_iam_member" "dead_letter_subscriber" {
  for_each = local.media_ready ? {
    media-worker         = google_pubsub_subscription.media_worker[0].name
    media-results-writer = google_pubsub_subscription.media_results[0].name
  } : {}

  project      = var.project_id
  subscription = each.value
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_agent
}

# --- The worker's identity (D126) -----------------------------------------------------------------
resource "google_service_account" "media_worker" {
  count = local.media_ready ? 1 : 0

  project      = var.project_id
  account_id   = "media-worker"
  display_name = "Media worker (Dapr, off Google Cloud): pulls media-jobs, publishes media-results"
}

resource "google_pubsub_subscription_iam_member" "media_worker" {
  count = local.media_ready ? 1 : 0

  project      = var.project_id
  subscription = google_pubsub_subscription.media_worker[0].name
  role         = "roles/pubsub.subscriber"
  member       = google_service_account.media_worker[0].member
}

resource "google_pubsub_topic_iam_member" "media_worker" {
  count = local.media_ready ? 1 : 0

  project = var.project_id
  topic   = google_pubsub_topic.media["media-results"].name
  role    = "roles/pubsub.publisher"
  member  = google_service_account.media_worker[0].member
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

resource "google_service_account" "media_results_push" {
  count = local.media_ready ? 1 : 0

  project      = var.project_id
  account_id   = "media-results-push"
  display_name = "Pub/Sub push: delivers media-results to the result writer"
}

# Pub/Sub's agent signs the push's OIDC token as media-results-push.
resource "google_service_account_iam_member" "media_results_push_token" {
  count = local.media_ready ? 1 : 0

  service_account_id = google_service_account.media_results_push[0].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.pubsub_agent
}

resource "google_cloud_run_v2_service" "result_writer" {
  count = local.media_ready ? 1 : 0

  project             = var.project_id
  name                = "workflow"
  location            = var.region
  deletion_protection = var.run_deletion_protection
  labels              = local.labels

  # No public address: internal traffic only (Pub/Sub's push from this project counts as internal),
  # and Cloud Run checks every request's token against run.invoker (media-results-push only).
  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
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

resource "google_cloud_run_v2_service_iam_member" "result_writer_push" {
  count = local.media_ready ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.result_writer[0].name
  role     = "roles/run.invoker"
  member   = google_service_account.media_results_push[0].member
}
