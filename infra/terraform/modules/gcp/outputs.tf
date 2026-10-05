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

output "api_read_url" {
  value = google_cloud_run_v2_service.api_read.uri
}
