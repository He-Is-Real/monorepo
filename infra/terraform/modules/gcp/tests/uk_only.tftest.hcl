# Every regional resource takes var.region, and only London is accepted (UK data; D119's interim
# guard while the organisation's location policy is postponed). Mock providers.

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

run "london_by_default" {
  command = plan

  assert {
    condition = (
      google_container_cluster.this.location == "europe-west2" &&
      google_cloud_run_v2_service.web.location == "europe-west2"
    )
    error_message = "The cluster and Cloud Run services are in London."
  }
}

run "region_only_london" {
  command = plan
  variables {
    region = "europe-west1"
  }
  expect_failures = [var.region]
}
