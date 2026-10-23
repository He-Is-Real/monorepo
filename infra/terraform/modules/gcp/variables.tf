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
  description = "Allow unauthenticated calls to api-public-read (Cloud Run skips the invoker check; D31). Public since 0.9."
  type        = bool
  default     = false
}

variable "api_public_read_media" {
  description = <<-EOT
    D52: what api-public-read needs to sign Bunny media links. Identifiers only;
    the keys stay in the bunny-* secrets named here, which the bunny root
    creates and lets api-public-read read. null = signing off (media URLs are
    null). Set it only after the bunny root has applied: a revision that can't
    read its keys doesn't start.
  EOT
  type = object({
    stream_library_id       = string
    stream_cdn_hostname     = string
    images_cdn_hostname     = string
    stream_token_key_secret = optional(string, "bunny-stream-token-key")
    images_token_key_secret = optional(string, "bunny-images-token-key")
  })
  default = null
  validation {
    condition = var.api_public_read_media == null || (
      can(regex("^[0-9]{1,12}$", var.api_public_read_media.stream_library_id)) &&
      can(regex("^[a-z0-9-]+(\\.[a-z0-9-]+)+$", var.api_public_read_media.stream_cdn_hostname)) &&
      can(regex("^[a-z0-9-]+(\\.[a-z0-9-]+)+$", var.api_public_read_media.images_cdn_hostname)) &&
      can(regex("^bunny-[a-z0-9-]+$", var.api_public_read_media.stream_token_key_secret)) &&
      can(regex("^bunny-[a-z0-9-]+$", var.api_public_read_media.images_token_key_secret))
    )
    error_message = "api_public_read_media: a numeric library id, bare hostnames, and bunny-* secret names."
  }
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
  description = "Allow unauthenticated visits to web (Cloud Run skips the invoker check). Public since 0.9."
  type        = bool
  default     = false
}

variable "web_invokers" {
  description = "Members allowed to call web when it isn't public (browse with `gcloud run services proxy web`)."
  type        = list(string)
  default     = []
}

variable "clerk_publishable_key" {
  description = "The Clerk instance's publishable key (public; D32: web passes it to the browser). Empty = no sign-in control."
  type        = string
  default     = ""
  validation {
    condition     = var.clerk_publishable_key == "" || can(regex("^pk_(test|live)_[A-Za-z0-9]+$", var.clerk_publishable_key))
    error_message = "clerk_publishable_key must be a Clerk publishable key (pk_test_… or pk_live_…), never a secret key."
  }
}

variable "web_origins" {
  description = "web's origins (its Cloud Run URLs), allowed to call the APIs from the browser (CORS, D31). Passed in rather than read from the service, which would be a dependency cycle."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for o in var.web_origins : can(regex("^https://[a-z0-9.-]+$", o))])
    error_message = "web_origins are https origins without a path."
  }
}

variable "web_featured_story_slug" {
  description = "The story web's home page shows (0.9: the dev seed's). Empty: none."
  type        = string
  default     = ""
}

variable "web_noindex" {
  description = "Tell search engines not to index web (X-Robots-Tag + robots meta). On in dev: public, but not a real site yet."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  description = "Delete database backups after this many days (GDPR erasure window)."
  type        = number
  default     = 30
}

variable "dev_seed" {
  description = "D49: the dev-seed Cloud Run Job that resets dev to the D47 dummy dataset, its service account and its database password (surreal-dev-seed-password; the cluster root's dev_seed_login creates the user). Dev only: refused unless the project is heisreal-dev."
  type        = bool
  default     = false
  nullable    = false
  validation {
    condition     = !var.dev_seed || var.project_id == "heisreal-dev"
    error_message = "dev_seed (D49) can only be set in dev (project heisreal-dev)."
  }
}

variable "ci_dev_seeder_email" {
  description = "D50: the CI identity (bootstrap root, ci-dev-seeder) allowed to start the dev-seed Job and watch its executions. Empty: none yet (bootstrap not applied)."
  type        = string
  default     = ""
}
