output "cluster_name" {
  value = google_container_cluster.this.name
}

output "cluster_location" {
  value = google_container_cluster.this.location
}

output "cluster_dns_endpoint" {
  description = "IAM-protected control-plane endpoint (no public IP endpoint exists)."
  value       = google_container_cluster.this.control_plane_endpoints_config[0].dns_endpoint_config[0].endpoint
}

output "registry" {
  description = "Artifact Registry paths for our images and the pull-through caches."
  value = {
    apps         = "${local.registry_host}/${var.project_id}/${google_artifact_registry_repository.apps.repository_id}"
    apps_scratch = "${local.registry_host}/${var.project_id}/${google_artifact_registry_repository.apps_scratch.repository_id}"
    dockerhub    = "${local.registry_host}/${var.project_id}/${google_artifact_registry_repository.dockerhub.repository_id}"
    ghcr         = "${local.registry_host}/${var.project_id}/${google_artifact_registry_repository.ghcr.repository_id}"
  }
}

output "run_subnet_cidr" {
  value = var.network_cidrs.run
}

output "surrealdb_host" {
  value = local.surrealdb_host
}

output "backups_bucket" {
  value = google_storage_bucket.backups.name
}

output "surrealdb_secrets_gsa" {
  value = google_service_account.surrealdb_secrets.email
}

output "surrealdb_backup_gsa" {
  value = google_service_account.surrealdb_backup.email
}

output "surreal_secret_rotation" {
  description = "Read by the cluster root: a new rotation restarts SurrealDB with the new passwords."
  value       = var.secret_rotation
}

output "api_public_read_url" {
  value = google_cloud_run_v2_service.api_public_read.uri
}

output "api_user_url" {
  value = google_cloud_run_v2_service.signed_in_api["api-user"].uri
}

output "api_admin_url" {
  value = google_cloud_run_v2_service.signed_in_api["api-admin"].uri
}

output "web_url" {
  value = google_cloud_run_v2_service.web.uri
}

output "dev_seed_job" {
  description = "D49: the dev-seed Cloud Run Job (gcloud run jobs execute <name> --region <region> --wait), or null outside dev."
  value       = var.dev_seed ? google_cloud_run_v2_job.dev_seed[0].name : null
}

output "legal_documents_bucket" {
  description = "The privacy policy and terms PDFs of record, as the admins uploaded them (legal_documents.tf)."
  value       = google_storage_bucket.legal_documents.name
}
