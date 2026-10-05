locals {
  name = "heisreal-${var.environment}"

  labels = {
    app         = "heisreal"
    environment = var.environment
    managed-by  = "terraform"
  }

  registry_host = "${var.region}-docker.pkg.dev"

  # Workload Identity: Kubernetes service accounts acting as Google ones.
  wi_pool = "${var.project_id}.svc.id.goog"

  surrealdb_host = "surrealdb.database.svc.${var.cluster_dns_domain}"
}
