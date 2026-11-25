# Axiom (LG-3, Joel 2026-11-25): every service that writes logs gets the dataset, the EU edge
# domain and the ingest token's secret name, and may read that one secret. OpenTofu holds only
# the empty container (no version: the owner adds the token by hand). Mock providers.

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
  axiom_dataset            = "heisreal-dev"
}

run "axiom" {
  command = plan

  assert {
    condition = (
      google_secret_manager_secret.axiom_ingest_token.secret_id == "axiom-ingest-token" &&
      google_secret_manager_secret.axiom_ingest_token.replication[0].user_managed[0].replicas[0].location == "europe-west2" &&
      length(google_secret_manager_secret.axiom_ingest_token.replication[0].user_managed[0].replicas) == 1
    )
    error_message = "The token's container is axiom-ingest-token, London only."
  }

  assert {
    condition = (
      toset(keys(google_secret_manager_secret_iam_member.axiom_ingest_token)) == toset(keys(local.log_hmac_reader_members)) &&
      alltrue([for g in google_secret_manager_secret_iam_member.axiom_ingest_token :
      g.secret_id == "axiom-ingest-token" && g.role == "roles/secretmanager.secretAccessor"])
    )
    error_message = "Exactly the services that write logs (the log keys' readers) may read the token, and only it."
  }

  assert {
    condition = alltrue([for c in concat(
      [google_cloud_run_v2_service.api_public_read.template[0].containers[0]],
      [for s in google_cloud_run_v2_service.signed_in_api : s.template[0].containers[0]],
      [google_cloud_run_v2_service.web.template[0].containers[0]],
      ) : {
      for e in c.env : e.name => e.value if startswith(e.name, "AXIOM_")
      } == {
      AXIOM_DATASET        = "heisreal-dev"
      AXIOM_TRACES_DATASET = "heisreal-traces"
      AXIOM_DOMAIN         = "eu-central-1.aws.edge.axiom.co"
      AXIOM_TOKEN_SECRET   = "axiom-ingest-token"
    }])
    error_message = "Every service gets the logs and traces datasets, the EU edge domain and the token's name (never its value)."
  }
}

run "off_without_a_dataset" {
  command = plan

  variables {
    axiom_dataset = null
  }

  assert {
    condition = length([for e in google_cloud_run_v2_service.web.template[0].containers[0].env :
    e if startswith(e.name, "AXIOM_")]) == 0
    error_message = "Without a dataset no service is told about Axiom (logs stay on stdout)."
  }
}
