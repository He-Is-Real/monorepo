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
