# The nightly housekeeping Job (housekeeping.tf): in London, its own identity reading only its own
# database password and Clerk's secret key (erasure retries), signing in as service:housekeeping, and started by Cloud Scheduler as a
# second identity that may start this one Job and nothing else. Mock providers.

mock_provider "google" {
  mock_resource "google_service_account" {
    defaults = {
      email  = "mock-account@heisreal-dev.iam.gserviceaccount.com"
      name   = "projects/heisreal-dev/serviceAccounts/mock-account@heisreal-dev.iam.gserviceaccount.com"
      member = "serviceAccount:mock-account@heisreal-dev.iam.gserviceaccount.com"
    }
  }
}
mock_provider "random" {}

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
}

run "off_by_default" {
  command = plan
  variables {
    housekeeping = null
  }

  assert {
    condition = (
      length(google_cloud_run_v2_job.housekeeping) == 0 &&
      length(google_cloud_scheduler_job.housekeeping) == 0 &&
      length(google_service_account.housekeeping) == 0 &&
      length(google_service_account.housekeeping_scheduler) == 0
    )
    error_message = "No housekeeping Job, trigger or identity unless housekeeping is set."
  }
}

run "in_london_nightly_dry_run_first" {
  command = plan

  assert {
    condition = (
      google_cloud_run_v2_job.housekeeping[0].location == "europe-west2" &&
      google_cloud_scheduler_job.housekeeping[0].region == "europe-west2" &&
      google_cloud_scheduler_job.housekeeping[0].time_zone == "Europe/London" &&
      google_cloud_scheduler_job.housekeeping[0].schedule == "30 3 * * *"
    )
    error_message = "The Job and its trigger are in London, nightly at 03:30 London time."
  }

  assert {
    condition = (
      one([for e in google_cloud_run_v2_job.housekeeping[0].template[0].template[0].containers[0].env :
      e.value if e.name == "HOUSEKEEPING_DRY_RUN"]) == "true" &&
      one([for e in google_cloud_run_v2_job.housekeeping[0].template[0].template[0].containers[0].env :
      e.value if e.name == "HOUSEKEEPING_MAX_DELETIONS"]) == "50"
    )
    error_message = "By default it only logs (dry run) and deletes at most 50 per chore."
  }
}

run "least_privilege" {
  command = plan

  assert {
    condition = (
      google_service_account.housekeeping[0].account_id == "housekeeping" &&
      google_service_account.housekeeping_scheduler[0].account_id == "housekeeping-scheduler"
    )
    error_message = "The Job and its trigger each have their own service account."
  }

  assert {
    condition = (
      length(google_secret_manager_secret_iam_member.housekeeping) == 1 &&
      google_secret_manager_secret_iam_member.housekeeping[0].secret_id == "surreal-housekeeping-password" &&
      google_secret_manager_secret_iam_member.housekeeping[0].role == "roles/secretmanager.secretAccessor"
    )
    error_message = "The Job reads only its own database password here (the Stream key's grant is the bunny root's)."
  }

  assert {
    condition = (
      length(google_secret_manager_secret_iam_member.housekeeping_clerk) == 1 &&
      google_secret_manager_secret_iam_member.housekeeping_clerk[0].secret_id == "clerk-secret-key" &&
      google_secret_manager_secret_iam_member.housekeeping_clerk[0].role == "roles/secretmanager.secretAccessor" &&
      google_secret_manager_secret_iam_member.housekeeping_clerk[0].member == google_service_account.housekeeping[0].member &&
      one([for e in google_cloud_run_v2_job.housekeeping[0].template[0].template[0].containers[0].env :
      e.value if e.name == "CLERK_SECRET_KEY_SECRET"]) == "clerk-secret-key" &&
      length([for e in google_cloud_run_v2_job.housekeeping[0].template[0].template[0].containers[0].env :
      e if e.name == "CLERK_WEBHOOK_SECRET_SECRET"]) == 0
    )
    error_message = "Of Clerk's secrets, the Job reads only the secret key (to retry erased people's Clerk deletions, D81), never the webhook's."
  }

  assert {
    condition = alltrue([
      one([for e in google_cloud_run_v2_job.housekeeping[0].template[0].template[0].containers[0].env :
      e.value if e.name == "SURREAL_USER"]) == "housekeeping",
      one([for e in google_cloud_run_v2_job.housekeeping[0].template[0].template[0].containers[0].env :
      e.value if e.name == "SURREAL_PASSWORD_SECRET"]) == "surreal-housekeeping-password",
      one([for e in google_cloud_run_v2_job.housekeeping[0].template[0].template[0].containers[0].env :
      e.value if e.name == "BUNNY_STREAM_API_KEY_SECRET"]) == "bunny-stream-api-key",
    ])
    error_message = "It signs in as service:housekeeping and names (never holds) the Stream key."
  }

  assert {
    condition = (
      google_cloud_run_v2_job_iam_member.housekeeping_scheduler[0].role == "roles/run.invoker" &&
      google_cloud_run_v2_job_iam_member.housekeeping_scheduler[0].name == "housekeeping" &&
      google_cloud_scheduler_job.housekeeping[0].http_target[0].oauth_token[0].service_account_email == google_service_account.housekeeping_scheduler[0].email &&
      endswith(google_cloud_scheduler_job.housekeeping[0].http_target[0].uri, "/locations/europe-west2/jobs/housekeeping:run")
    )
    error_message = "Scheduler starts this one Job, as its own identity with run.invoker on that Job only."
  }

}

run "needs_the_stream_library" {
  command = plan
  variables {
    api_public_read_media = null
  }
  expect_failures = [google_cloud_run_v2_job.housekeeping]
}

run "bounded_deletions" {
  command = plan
  variables {
    housekeeping = { max_deletions = 5000 }
  }
  expect_failures = [var.housekeeping]
}

# Picture deletions (M2 plan PR 10): with the images zone set, the Job gets the zone, its S3 host
# and its password's secret name (never a value); without it, none of them.
run "images_zone_with_image_uploads" {
  command = plan
  variables {
    api_user_image_uploads = {
      storage_zone = "heisreal-dev-image-store"
      s3_host      = "uk-s3.storage.bunnycdn.com"
      s3_region    = "uk"
    }
  }

  assert {
    condition = (
      { for e in google_cloud_run_v2_job.housekeeping[0].template[0].template[0].containers[0].env :
        e.name => e.value if startswith(e.name, "BUNNY_STORAGE_") } == {
        BUNNY_STORAGE_ZONE            = "heisreal-dev-image-store"
        BUNNY_STORAGE_S3_HOST         = "uk-s3.storage.bunnycdn.com"
        BUNNY_STORAGE_PASSWORD_SECRET = "bunny-storage-password"
      }
    )
    error_message = "With image uploads on, housekeeping gets the images zone and its password's secret name."
  }
}

run "no_images_zone_without_image_uploads" {
  command = plan

  assert {
    condition = length([for e in google_cloud_run_v2_job.housekeeping[0].template[0].template[0].containers[0].env :
    e if startswith(e.name, "BUNNY_STORAGE_")]) == 0
    error_message = "Without image uploads, housekeeping gets no images zone; picture deletions wait."
  }
}

# The 18:00 media resend (Joel, 2026-11-07): with media ready, a second trigger at 18:00 London
# time starts the same Job with only the resend (an override), as its own identity that may start
# this Job only; the nightly trigger stays without overrides, and the Job's own chores are the
# nightly ones. The Job may publish to media-jobs and names it.
run "media_resend_at_18_london_with_only_the_resend" {
  command = plan
  variables {
    media_ready = { worker_impersonators = ["user:joel@heisreal.today"] }
  }

  override_resource {
    target = google_service_account.housekeeping
    values = {
      email  = "housekeeping@heisreal-dev.iam.gserviceaccount.com"
      member = "serviceAccount:housekeeping@heisreal-dev.iam.gserviceaccount.com"
    }
  }
  override_resource {
    target = google_service_account.housekeeping_scheduler
    values = {
      email  = "housekeeping-scheduler@heisreal-dev.iam.gserviceaccount.com"
      member = "serviceAccount:housekeeping-scheduler@heisreal-dev.iam.gserviceaccount.com"
    }
  }
  override_resource {
    target = google_service_account.media_resend_scheduler
    values = {
      email  = "media-resend-scheduler@heisreal-dev.iam.gserviceaccount.com"
      member = "serviceAccount:media-resend-scheduler@heisreal-dev.iam.gserviceaccount.com"
    }
  }

  assert {
    condition = (
      google_cloud_scheduler_job.media_resend[0].schedule == "0 18 * * *" &&
      google_cloud_scheduler_job.media_resend[0].time_zone == "Europe/London" &&
      google_cloud_scheduler_job.media_resend[0].region == "europe-west2" &&
      endswith(google_cloud_scheduler_job.media_resend[0].http_target[0].uri, "/locations/europe-west2/jobs/housekeeping:run") &&
      jsondecode(base64decode(google_cloud_scheduler_job.media_resend[0].http_target[0].body)) == {
        overrides = { containerOverrides = [{ env = [{ name = "HOUSEKEEPING_CHORES", value = "media-resend" }] }] }
      }
    )
    error_message = "At 18:00 London time a second trigger starts the housekeeping Job with only the media resend."
  }

  assert {
    condition = (
      google_cloud_scheduler_job.housekeeping[0].schedule == "30 3 * * *" &&
      google_cloud_scheduler_job.housekeeping[0].http_target[0].body == null &&
      one([for e in google_cloud_run_v2_job.housekeeping[0].template[0].template[0].containers[0].env :
      e.value if e.name == "HOUSEKEEPING_CHORES"]) == "nightly"
    )
    error_message = "The 03:30 run is the nightly chores, with no override: it never resends."
  }

  assert {
    condition = (
      google_service_account.media_resend_scheduler[0].account_id == "media-resend-scheduler" &&
      google_cloud_scheduler_job.media_resend[0].http_target[0].oauth_token[0].service_account_email == "media-resend-scheduler@heisreal-dev.iam.gserviceaccount.com" &&
      google_cloud_run_v2_job_iam_member.media_resend_scheduler[0].role == "roles/run.jobsExecutorWithOverrides" &&
      google_cloud_run_v2_job_iam_member.media_resend_scheduler[0].name == "housekeeping" &&
      google_cloud_run_v2_job_iam_member.media_resend_scheduler[0].member == "serviceAccount:media-resend-scheduler@heisreal-dev.iam.gserviceaccount.com" &&
      google_cloud_run_v2_job_iam_member.housekeeping_scheduler[0].role == "roles/run.invoker" &&
      google_cloud_run_v2_job_iam_member.housekeeping_scheduler[0].member == "serviceAccount:housekeeping-scheduler@heisreal-dev.iam.gserviceaccount.com"
    )
    error_message = "Only the resend trigger's own identity may start the Job with overrides, on that Job only; the nightly trigger's may not."
  }

  assert {
    condition = (
      google_pubsub_topic_iam_member.housekeeping_media_jobs[0].topic == "media-jobs" &&
      google_pubsub_topic_iam_member.housekeeping_media_jobs[0].role == "roles/pubsub.publisher" &&
      google_pubsub_topic_iam_member.housekeeping_media_jobs[0].member == "serviceAccount:housekeeping@heisreal-dev.iam.gserviceaccount.com" &&
      one([for e in google_cloud_run_v2_job.housekeeping[0].template[0].template[0].containers[0].env :
      e.value if e.name == "MEDIA_JOBS_TOPIC"]) == "media-jobs"
    )
    error_message = "The Job may publish to media-jobs (and names it) for the resend."
  }
}

run "no_media_resend_without_media_ready" {
  command = plan

  assert {
    condition = (
      length(google_cloud_scheduler_job.media_resend) == 0 &&
      length(google_service_account.media_resend_scheduler) == 0 &&
      length(google_pubsub_topic_iam_member.housekeeping_media_jobs) == 0 &&
      length([for e in google_cloud_run_v2_job.housekeeping[0].template[0].template[0].containers[0].env :
      e if e.name == "MEDIA_JOBS_TOPIC"]) == 0
    )
    error_message = "Without media ready there is no queue: no resend trigger, identity or publish grant."
  }
}
