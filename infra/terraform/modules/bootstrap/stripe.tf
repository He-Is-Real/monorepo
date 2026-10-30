# Stripe API key for the stripe root's provider (donations, Joel 2026-10-29), read
# ephemerally at plan/apply time and never written to state. OpenTofu owns the
# container; the value is human-supplied: Joel adds a restricted key as a new
# version (runbook: infra/terraform/README.md "Stripe"). In dev it must be a
# sandbox key (rk_test_…); the stripe module refuses to plan with a live one.
#
# tf-deployer applies the stripe root, so it may read this one secret: a grant on
# the secret, not the project, so its other secrets stay unreadable to it
# (ci_identity.tf). tf-deployer is available to CI only on main (deploy_gate), so
# pull requests never plan stripe. Here rather than in the gcp root so the
# deployer doesn't grant itself the read.
resource "google_secret_manager_secret" "stripe_api_key" {
  project   = google_project.this.project_id
  secret_id = "stripe-api-key"
  labels    = merge(local.labels, { component = "stripe" })

  replication {
    user_managed {
      replicas {
        location = var.region # GDPR: stays in the UK
      }
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_secret_manager_secret_iam_member" "stripe_api_key_deployer" {
  project   = google_secret_manager_secret.stripe_api_key.project
  secret_id = google_secret_manager_secret.stripe_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.tf_deployer.member
}
