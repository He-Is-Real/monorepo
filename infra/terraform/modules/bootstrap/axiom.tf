# Axiom API token for the axiom root's provider (the logs dataset, LG-3), read ephemerally at
# plan/apply time and never written to state. OpenTofu owns the container; the value is
# human-supplied: Joel makes an advanced token `heisreal-terraform` in Axiom and adds it as a new
# version (runbook: infra/terraform/README.md "Axiom (logs)").
#
# Same shape as stripe.tf: tf-deployer applies the axiom root, so it may read this one secret (a
# grant on the secret, not the project). tf-deployer is available to CI only on main
# (deploy_gate), so pull requests never plan axiom. Here rather than in the gcp root so the
# deployer doesn't grant itself the read.
resource "google_secret_manager_secret" "axiom_terraform_token" {
  project   = google_project.this.project_id
  secret_id = "axiom-terraform-token"
  labels    = merge(local.labels, { component = "axiom" })

  replication {
    user_managed {
      replicas {
        location = var.region # GDPR: stays in the UK
      }
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_secret_manager_secret_iam_member" "axiom_terraform_token_deployer" {
  project   = google_secret_manager_secret.axiom_terraform_token.project
  secret_id = google_secret_manager_secret.axiom_terraform_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.tf_deployer.member
}
