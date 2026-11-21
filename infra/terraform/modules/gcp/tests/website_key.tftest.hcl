# The website key (rate limits, RL-8 A, Joel 2026-11-21): web gets its value only from Secret
# Manager (never as a plain value in the plan), api-public-read gets only its name, and only
# those two service accounts may read it. Mock providers.

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
}

run "website_key" {
  command = plan

  assert {
    condition     = google_secret_manager_secret.website_key.secret_id == "website-key"
    error_message = "The website key is the website-key secret."
  }

  assert {
    condition     = google_secret_manager_secret.website_key.replication[0].user_managed[0].replicas[0].location == "europe-west2"
    error_message = "The website key stays in London."
  }

  assert {
    condition = alltrue([for e in google_cloud_run_v2_service.web.template[0].containers[0].env :
      e.value_source[0].secret_key_ref[0].secret == "website-key" && (e.value == null || e.value == "")
    if e.name == "WEBSITE_KEY"])
    error_message = "web gets WEBSITE_KEY from Secret Manager, never as a plain value."
  }

  assert {
    condition = length([for e in google_cloud_run_v2_service.web.template[0].containers[0].env :
    e if e.name == "WEBSITE_KEY"]) == 1
    error_message = "web gets WEBSITE_KEY."
  }

  assert {
    condition = one([for e in google_cloud_run_v2_service.api_public_read.template[0].containers[0].env :
    e.value if e.name == "WEBSITE_KEY_SECRET"]) == "website-key"
    error_message = "api-public-read gets the website key's name, and reads its value itself."
  }

  assert {
    condition     = toset(keys(google_secret_manager_secret_iam_member.website_key)) == toset(["web", "api-public-read"])
    error_message = "Only web and api-public-read may read the website key."
  }
}
