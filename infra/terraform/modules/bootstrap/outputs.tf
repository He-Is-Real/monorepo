output "project_id" {
  value = google_project.this.project_id
}

output "project_number" {
  value = google_project.this.number
}

output "tfstate_bucket" {
  value = google_storage_bucket.tfstate.name
}

output "workload_identity_provider" {
  description = "Full provider name for google-github-actions/auth."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "tf_planner_email" {
  value = google_service_account.tf_planner.email
}

output "tf_cluster_planner_email" {
  value = google_service_account.tf_cluster_planner.email
}

output "tf_deployer_email" {
  value = google_service_account.tf_deployer.email
}

output "ci_image_pusher_email" {
  value = google_service_account.ci_image_pusher.email
}

output "ci_snapshot_pusher_email" {
  value = google_service_account.ci_snapshot_pusher.email
}

output "bunny_account_api_key_secret" {
  description = "Secret Manager secret holding the Bunny.net account API key (value added by a developer; read by live/<env>/bunny)."
  value       = google_secret_manager_secret.bunny_account_api_key.secret_id
}

output "tf_bunny_email" {
  value = google_service_account.tf_bunny.email
}

output "kms_state_key" {
  description = "KMS key for every state but bunny's (live/<env>/*/encryption.tf)."
  value       = google_kms_crypto_key.state.id
}

output "kms_bunny_key" {
  description = "KMS key for the bunny root's state and plans."
  value       = google_kms_crypto_key.bunny.id
}
