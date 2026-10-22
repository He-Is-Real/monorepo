# Bunny.net account API key, used only by the bunny root's provider (read
# ephemerally at plan/apply time, never written to state). Terraform owns the
# container; the value is human-supplied: a developer adds it as a new version
# (runbook: infra/terraform/README.md "Bunny.net"). Here rather than in the gcp
# root because only developers and tf-bunny may manage `bunny-*` secrets:
# tf-deployer's secrets role excludes them (ci_identity.tf), and tf-bunny's
# grants are limited to them (tf_bunny.tf).
resource "google_secret_manager_secret" "bunny_account_api_key" {
  project   = google_project.this.project_id
  secret_id = "bunny-account-api-key"
  labels    = merge(local.labels, { component = "bunny" })

  replication {
    user_managed {
      replicas {
        location = var.region # GDPR: stays in the UK
      }
    }
  }

  depends_on = [google_project_service.this]
}

# The legacy Cloud Build service account's default grant includes
# storage.objects.get on every bucket, so anyone able to run a build or trigger
# could read the bunny root's state (and any other) through it; unlike a
# service agent it acts for whoever starts the build. Nothing here uses Cloud
# Build (its API is disabled), so the dormant default grant is removed.
resource "google_project_iam_member_remove" "legacy_cloudbuild_builder" {
  project = google_project.this.project_id
  role    = "roles/cloudbuild.builds.builder"
  member  = "serviceAccount:${google_project.this.number}@cloudbuild.gserviceaccount.com"

  # The removal rewrites the whole project policy without retrying on conflicts, so it runs
  # after every other project IAM write in this root (and after API enabling, which can add
  # service agent grants).
  depends_on = [
    google_project_service.this,
    google_project_iam_member.developers_owner,
    google_project_iam_member.developers_storage,
    google_project_iam_member.tf_planner,
    google_project_iam_member.tf_cluster_planner,
    google_project_iam_member.tf_deployer,
    google_project_iam_member.tf_deployer_custom,
    google_project_iam_member.tf_deployer_parent,
    google_project_iam_member.tf_deployer_project_iam,
    google_project_iam_member.tf_bunny_security_reviewer,
    google_project_iam_member.tf_bunny_parent,
    google_project_iam_member.tf_bunny_secrets,
  ]
}
