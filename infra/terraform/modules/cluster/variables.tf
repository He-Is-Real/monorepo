variable "surrealdb_overlay_path" {
  description = "Path to the environment's Kustomize overlay (infra/k8s/surrealdb/overlays/<env>)."
  type        = string
}

variable "surrealdb_replicas" {
  description = "0 = SurrealDB stopped (disk kept), 1 = running. RocksDB is single-writer: never more than 1."
  type        = number
  default     = 1
  validation {
    condition     = contains([0, 1], var.surrealdb_replicas)
    error_message = "surrealdb_replicas must be 0 or 1."
  }
}

variable "eso_chart_version" {
  description = "External Secrets Operator Helm chart version."
  type        = string
  default     = "2.11.0"
}

variable "eso_image_repository" {
  description = "ESO image, pulled through the Artifact Registry ghcr.io cache."
  type        = string
}

variable "surrealdb_expected_settings" {
  description = "Values the overlay's settings.env must contain (from the gcp root), so the two can't drift apart."
  type        = map(string)
}

variable "backup_run" {
  description = "Set to a new id (e.g. 20261005a) to run a backup now; empty = none. The Job stays until the id changes or is cleared."
  type        = string
  default     = ""
  validation {
    condition     = can(regex("^[a-z0-9-]{0,30}$", var.backup_run))
    error_message = "backup_run: lowercase letters, digits and dashes, at most 30 characters."
  }
}

variable "schema_dir" {
  description = "libs/database/schema: the migration bundle (D14)."
  type        = string
}

variable "dpa_dir" {
  description = "libs/legal/dpa: DPA texts, hashed into the migration (D20)."
  type        = string
}

variable "identity_rotation" {
  description = "The gcp root's secret_rotation. A change gives SurrealDB a new init Secret (latest password versions) and restarts it."
  type        = string
  default     = "1"
}

variable "clerk_jwt_public_key" {
  description = "Clerk's RS256 PEM public key (public, not a secret). Empty until Clerk is set up (task 0.5): the migration then removes DEFINE ACCESS clerk, so no person sessions."
  type        = string
  default     = ""
}
