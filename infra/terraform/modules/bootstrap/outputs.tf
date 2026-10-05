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

output "tf_deployer_email" {
  value = google_service_account.tf_deployer.email
}

output "ci_image_pusher_email" {
  value = google_service_account.ci_image_pusher.email
}

output "ci_snapshot_pusher_email" {
  value = google_service_account.ci_snapshot_pusher.email
}
