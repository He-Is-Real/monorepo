variable "project_id" {
  type = string
}

variable "environment" {
  description = "dev, prod, ..."
  type        = string
}

variable "region" {
  type    = string
  default = "europe-west2"
}

variable "network_cidrs" {
  description = "Address plan. The run subnet must be at least /26 (Cloud Run Direct VPC egress)."
  type = object({
    gke      = string
    pods     = string
    services = string
    run      = string
  })
  default = {
    gke      = "10.10.0.0/20"
    pods     = "10.20.0.0/17"
    services = "10.30.0.0/22"
    run      = "10.10.16.0/26"
  }
}

variable "cluster_dns_domain" {
  description = "Additive VPC-scope DNS domain: cluster Services resolve as <svc>.<ns>.svc.<domain> anywhere in the VPC (lets Cloud Run reach SurrealDB without a load balancer). Autopilot: creation-time only."
  type        = string
}

variable "deletion_protection" {
  description = "Protect the GKE cluster from terraform destroy."
  type        = bool
  default     = true
}

variable "run_deletion_protection" {
  description = "Protect the Cloud Run services from terraform destroy. Set to false and apply before replacing a service (e.g. a rename): the provider refuses to delete a protected one."
  type        = bool
  default     = true
}

variable "ci_snapshot_pusher_email" {
  description = "Service account the snapshot workflow uses to push to apps-scratch (from the bootstrap root)."
  type        = string
}

variable "ci_image_pusher_email" {
  description = "Service account CI uses to push images (from the bootstrap root)."
  type        = string
}

variable "surreal_secret_names" {
  description = "Secret Manager secrets holding SurrealDB passwords: root, one per service login (D13 B service records) and the migrator/backup system users."
  type        = list(string)
  default = [
    "surreal-root-password",
    "surreal-api-public-read-password",
    "surreal-api-user-password",
    "surreal-api-admin-password",
    "surreal-workflow-password",
    "surreal-backup-password",
    "surreal-migrator-password",
  ]
}

variable "secret_rotation" {
  description = "Bump to rotate the SurrealDB service, migrator and backup passwords; the init Job then rewrites the service login hashes and system users on its next run (see infra/k8s/surrealdb/README.md)."
  type        = number
  default     = 1
}

variable "root_secret_rotation" {
  description = "Bump to rotate the SurrealDB root password. SurrealDB only reads it on first start, so an existing database must be told with the previous version: see infra/k8s/surrealdb/README.md 'Rotating passwords'."
  type        = number
  default     = 1
}

variable "images" {
  description = "Service -> image by digest (resolved by the live root). A missing service runs Google's placeholder hello image."
  type        = map(string)
  default     = {}
}

variable "api_public_read_max_instances" {
  description = "Scale-up cap for api-public-read on Cloud Run."
  type        = number
  default     = 2
}

variable "api_public_read_public" {
  description = "Allow unauthenticated calls to api-public-read. Dev keeps it private (invokers only)."
  type        = bool
  default     = false
}

variable "api_public_read_invokers" {
  description = "Members allowed to call api-public-read when it isn't public (e.g. user:someone@heisreal.today)."
  type        = list(string)
  default     = []
}

variable "web_max_instances" {
  description = "Scale-up cap for web on Cloud Run."
  type        = number
  default     = 2
}

variable "web_public" {
  description = "Allow unauthenticated visits to web. Dev keeps it private (invokers only) until task 0.9."
  type        = bool
  default     = false
}

variable "web_invokers" {
  description = "Members allowed to call web when it isn't public (browse with `gcloud run services proxy web`)."
  type        = list(string)
  default     = []
}

variable "backup_retention_days" {
  description = "Delete database backups after this many days (GDPR erasure window)."
  type        = number
  default     = 30
}
