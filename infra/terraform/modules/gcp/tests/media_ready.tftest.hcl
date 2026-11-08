# Media ready (M2 plan item 13; D78, D126; media-worker-final.html): the job topic keeps messages in
# London only and is the only media topic (no answers queue, no dead letters: Joel, 2026-11-07,
# J4/J5); the worker's subscription never expires; only the worker may call the result writer;
# the worker may pull jobs and call the writer but read no database password; only organisation
# people may act as it. Mock providers.

mock_provider "google" {
  mock_resource "google_service_account" {
    defaults = {
      email  = "mock-account@heisreal-dev.iam.gserviceaccount.com"
      name   = "projects/heisreal-dev/serviceAccounts/mock-account@heisreal-dev.iam.gserviceaccount.com"
      member = "serviceAccount:mock-account@heisreal-dev.iam.gserviceaccount.com"
    }
  }
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
}
mock_provider "random" {}

override_resource {
  target = google_service_account.media_worker
  values = {
    email  = "media-worker@heisreal-dev.iam.gserviceaccount.com"
    name   = "projects/heisreal-dev/serviceAccounts/media-worker@heisreal-dev.iam.gserviceaccount.com"
    member = "serviceAccount:media-worker@heisreal-dev.iam.gserviceaccount.com"
  }
}
override_resource {
  target = google_service_account.result_writer
  values = {
    email  = "workflow@heisreal-dev.iam.gserviceaccount.com"
    name   = "projects/heisreal-dev/serviceAccounts/workflow@heisreal-dev.iam.gserviceaccount.com"
    member = "serviceAccount:workflow@heisreal-dev.iam.gserviceaccount.com"
  }
}

variables {
  project_id               = "heisreal-dev"
  environment              = "dev"
  cluster_dns_domain       = "cluster.heisreal-dev.internal"
  ci_image_pusher_email    = "ci-image-pusher@heisreal-dev.iam.gserviceaccount.com"
  ci_snapshot_pusher_email = "ci-snapshot-pusher@heisreal-dev.iam.gserviceaccount.com"
  web_origins              = ["https://web-abc-nw.a.run.app"]
  clerk_issuer             = "https://example.clerk.accounts.dev"
  clerk_jwt_public_key     = "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n"
  api_public_read_media = {
    stream_library_id   = "789855"
    stream_cdn_hostname = "vz-example.b-cdn.net"
    images_cdn_hostname = "example-images.b-cdn.net"
  }
  housekeeping = {}
  media_ready = {
    worker_impersonators = ["user:joel@heisreal.today"]
  }
}

run "off_by_default" {
  command = plan
  variables {
    media_ready = null
  }

  assert {
    condition = (
      length(google_pubsub_topic.media) == 0 &&
      length(google_pubsub_subscription.media_worker) == 0 &&
      length(google_service_account.media_worker) == 0 &&
      length(google_cloud_run_v2_service.result_writer) == 0
    )
    error_message = "No topics, worker identity or result writer unless media_ready is set."
  }
  assert {
    condition = alltrue([for e in google_cloud_run_v2_service.signed_in_api["api-user"].template[0].containers[0].env :
    !contains(["BUNNY_STREAM_READONLY_KEY_SECRET", "MEDIA_JOBS_TOPIC"], e.name)])
    error_message = "Without media_ready api-user gets no webhook settings (the webhook answers 503)."
  }
}

run "messages_stay_in_london" {
  command = plan

  assert {
    condition = (
      toset(keys(google_pubsub_topic.media)) == toset(["media-jobs"]) &&
      alltrue([for t in google_pubsub_topic.media :
        t.message_storage_policy[0].allowed_persistence_regions == toset(["europe-west2"]) &&
        t.message_storage_policy[0].enforce_in_transit == true
      ])
    )
    error_message = "The job topic is the only media topic, and stores its messages in London only, enforced in transit too."
  }
  assert {
    condition     = google_cloud_run_v2_service.result_writer[0].location == "europe-west2"
    error_message = "The result writer runs in London."
  }
}

run "jobs_wait_while_the_worker_is_off" {
  command = plan

  assert {
    condition = (
      google_pubsub_subscription.media_worker[0].expiration_policy[0].ttl == "" &&
      google_pubsub_subscription.media_worker[0].message_retention_duration == "2678400s" &&
      length(google_pubsub_subscription.media_worker[0].push_config) == 0 &&
      length(google_pubsub_subscription.media_worker[0].dead_letter_policy) == 0 &&
      google_pubsub_subscription.media_worker[0].enable_message_ordering == true
    )
    error_message = "The worker's pull subscription never expires, keeps jobs 31 days, delivers in order per story and has no dead letters (J4)."
  }
}

run "only_the_worker_calls_the_writer" {
  command = plan

  assert {
    condition = (
      google_cloud_run_v2_service.result_writer[0].ingress == "INGRESS_TRAFFIC_ALL" &&
      google_cloud_run_v2_service.result_writer[0].invoker_iam_disabled == false
    )
    error_message = "The worker reaches the result writer from Joel's machine, and Cloud Run checks every caller."
  }
  assert {
    condition = (
      length(google_cloud_run_v2_service_iam_member.result_writer_worker) == 1 &&
      google_cloud_run_v2_service_iam_member.result_writer_worker[0].role == "roles/run.invoker" &&
      google_cloud_run_v2_service_iam_member.result_writer_worker[0].member == "serviceAccount:media-worker@heisreal-dev.iam.gserviceaccount.com"
    )
    error_message = "Only the media-worker account may call the result writer."
  }
  assert {
    condition = alltrue(flatten([
      [for g in google_pubsub_topic_iam_member.api_user_media_jobs : !contains(["allUsers", "allAuthenticatedUsers"], g.member)],
      [for g in google_pubsub_topic_iam_member.result_writer_media_jobs : !contains(["allUsers", "allAuthenticatedUsers"], g.member)],
      [for g in google_pubsub_subscription_iam_member.media_worker : !contains(["allUsers", "allAuthenticatedUsers"], g.member)],
      [for g in google_service_account_iam_member.media_worker_impersonators : !contains(["allUsers", "allAuthenticatedUsers"], g.member)],
      [for g in google_cloud_run_v2_service_iam_member.result_writer_worker : !contains(["allUsers", "allAuthenticatedUsers"], g.member)],
    ]))
    error_message = "No media grant is public."
  }
}

run "the_worker_reaches_the_queue_only" {
  command = plan

  assert {
    condition = (
      google_pubsub_subscription_iam_member.media_worker[0].role == "roles/pubsub.subscriber" &&
      google_pubsub_subscription_iam_member.media_worker[0].subscription == "media-worker-media-jobs"
    )
    error_message = "The worker pulls its own subscription."
  }
  assert {
    condition = alltrue(flatten([
      [for g in google_secret_manager_secret_iam_member.surrealdb_secrets : g.member != "serviceAccount:media-worker@heisreal-dev.iam.gserviceaccount.com"],
      [for g in google_secret_manager_secret_iam_member.signed_in_api : g.member != "serviceAccount:media-worker@heisreal-dev.iam.gserviceaccount.com"],
      [for g in google_secret_manager_secret_iam_member.housekeeping : g.member != "serviceAccount:media-worker@heisreal-dev.iam.gserviceaccount.com"],
      [for g in google_secret_manager_secret_iam_member.result_writer : g.member != "serviceAccount:media-worker@heisreal-dev.iam.gserviceaccount.com"],
    ]))
    error_message = "The worker reads no database password (D78: it never reaches the database)."
  }
  assert {
    condition = (
      google_secret_manager_secret_iam_member.result_writer[0].secret_id == "surreal-workflow-password" &&
      google_secret_manager_secret_iam_member.result_writer[0].member == "serviceAccount:workflow@heisreal-dev.iam.gserviceaccount.com"
    )
    error_message = "The result writer reads its own database password (the workflow login)."
  }
  assert {
    condition = (
      length(google_service_account_iam_member.media_worker_impersonators) == 1 &&
      google_service_account_iam_member.media_worker_impersonators["user:joel@heisreal.today"].role == "roles/iam.serviceAccountTokenCreator"
    )
    error_message = "D126: the named person may act as the worker with their own login."
  }
}

run "api_user_queues_jobs" {
  command = plan

  assert {
    condition = (
      google_pubsub_topic_iam_member.api_user_media_jobs[0].topic == "media-jobs" &&
      google_pubsub_topic_iam_member.api_user_media_jobs[0].role == "roles/pubsub.publisher"
    )
    error_message = "api-user may publish to media-jobs."
  }
  assert {
    condition = (
      contains([for e in google_cloud_run_v2_service.signed_in_api["api-user"].template[0].containers[0].env : "${e.name}=${e.value}"], "BUNNY_STREAM_READONLY_KEY_SECRET=bunny-stream-readonly-key") &&
      contains([for e in google_cloud_run_v2_service.signed_in_api["api-user"].template[0].containers[0].env : "${e.name}=${e.value}"], "MEDIA_JOBS_TOPIC=media-jobs") &&
      contains([for e in google_cloud_run_v2_service.signed_in_api["api-user"].template[0].containers[0].env : "${e.name}=${e.value}"], "BUNNY_STREAM_LIBRARY_ID=789855")
    )
    error_message = "api-user gets the read-only key's secret name, the library id and the jobs topic."
  }
  assert {
    condition = alltrue([for e in google_cloud_run_v2_service.signed_in_api["api-admin"].template[0].containers[0].env :
    !contains(["BUNNY_STREAM_READONLY_KEY_SECRET", "MEDIA_JOBS_TOPIC"], e.name)])
    error_message = "api-admin gets none of it."
  }
}

# Audio picture videos and a video's picture (Joel, 2026-11-07: K1; 2026-11-06: part A): the
# writer opens and sends jobs itself, and knows the Bunny library, the images CDN and the names of
# the two key secrets (the bunny root grants it those two only). The worker gets none of them.
run "the_writer_sends_jobs_and_reaches_bunny" {
  command = plan

  assert {
    condition = (
      google_pubsub_topic_iam_member.result_writer_media_jobs[0].topic == "media-jobs" &&
      google_pubsub_topic_iam_member.result_writer_media_jobs[0].role == "roles/pubsub.publisher" &&
      google_pubsub_topic_iam_member.result_writer_media_jobs[0].member == "serviceAccount:workflow@heisreal-dev.iam.gserviceaccount.com"
    )
    error_message = "The result writer may publish to media-jobs."
  }
  assert {
    condition = alltrue([for want in [
      "MEDIA_JOBS_TOPIC=media-jobs",
      "BUNNY_STREAM_LIBRARY_ID=789855",
      "BUNNY_STREAM_API_KEY_SECRET=bunny-stream-api-key",
      "BUNNY_IMAGES_CDN_HOST=example-images.b-cdn.net",
      "BUNNY_IMAGES_TOKEN_KEY_SECRET=bunny-images-token-key",
      ] : contains([for e in google_cloud_run_v2_service.result_writer[0].template[0].containers[0].env : "${e.name}=${e.value}"], want)
    ])
    error_message = "The result writer gets the jobs topic, the library, the images CDN and the two key secrets' names."
  }
}

run "impersonators_are_organisation_people" {
  command = plan
  variables {
    media_ready = { worker_impersonators = ["serviceAccount:api-user@heisreal-dev.iam.gserviceaccount.com"] }
  }
  expect_failures = [var.media_ready]
}

run "no_public_impersonators" {
  command = plan
  variables {
    media_ready = { worker_impersonators = ["allUsers"] }
  }
  expect_failures = [var.media_ready]
}

run "no_outside_impersonators" {
  command = plan
  variables {
    media_ready = { worker_impersonators = ["user:someone@gmail.com"] }
  }
  expect_failures = [var.media_ready]
}
