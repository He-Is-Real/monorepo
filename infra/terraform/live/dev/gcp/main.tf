# Dev GCP infrastructure: network, registry, GKE Autopilot, secrets, backups,
# and Cloud Run (api-read, running the images chosen in images.auto.tfvars).

terraform {
  required_version = ">= 1.11"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.5"
    }
  }
}

provider "google" {
  project = "heisreal-dev"
  region  = "europe-west2"
}

data "terraform_remote_state" "bootstrap" {
  backend = "gcs"
  config = {
    bucket = "heisreal-dev-tfstate"
    prefix = "dev/bootstrap"
  }
}

locals {
  bootstrap = data.terraform_remote_state.bootstrap.outputs.bootstrap
}

# --- Which image each service runs -----------------------------------------
# Committed in images.auto.tfvars; see infra/terraform/README.md "Images".
# The plan shows the digest every entry resolves to.

variable "images" {
  description = <<-EOT
    Service -> image. "main" = newest CI build from main (repo apps);
    "snapshot" = newest development build (repo apps-scratch); or an exact
    digest (…/apps/<service>@sha256:… or …/apps-scratch/<service>@sha256:…).
  EOT
  type        = map(string)
  validation {
    condition = alltrue([for s, img in var.images :
      contains(["main", "snapshot"], img) ||
      can(regex("^europe-west2-docker\\.pkg\\.dev/heisreal-dev/apps(-scratch)?/${s}@sha256:[0-9a-f]{64}$", img))
    ])
    error_message = "Each image must be \"main\", \"snapshot\" or a digest from apps / apps-scratch for that service."
  }
}

variable "image_overrides" {
  description = "One-off overrides for a single apply, e.g. -var 'image_overrides={\"api-read\"=\"snapshot\"}'. The next apply without it returns to images.auto.tfvars."
  type        = map(string)
  default     = {}
  validation {
    condition = alltrue([for s, img in var.image_overrides :
      contains(["main", "snapshot"], img) ||
      can(regex("^europe-west2-docker\\.pkg\\.dev/heisreal-dev/apps(-scratch)?/${s}@sha256:[0-9a-f]{64}$", img))
    ])
    error_message = "Each image must be \"main\", \"snapshot\" or a digest from apps / apps-scratch for that service."
  }
}

locals {
  wanted_images = merge(var.images, var.image_overrides)
  image_repo    = { main = "apps", snapshot = "apps-scratch" }
}

# Without a tag or digest, the data source returns the most recently pushed image.
data "google_artifact_registry_docker_image" "newest" {
  for_each = { for s, img in local.wanted_images : s => local.image_repo[img] if contains(["main", "snapshot"], img) }

  location      = "europe-west2"
  repository_id = each.value
  image_name    = each.key
}

locals {
  resolved_images = {
    for s, img in local.wanted_images :
    s => contains(["main", "snapshot"], img) ? data.google_artifact_registry_docker_image.newest[s].self_link : img
  }
}

module "gcp" {
  source = "../../../modules/gcp"

  project_id  = local.bootstrap.project_id
  environment = "dev"
  region      = "europe-west2"

  cluster_dns_domain = "cluster.heisreal-dev.internal"

  ci_image_pusher_email    = local.bootstrap.ci_image_pusher_email
  ci_snapshot_pusher_email = local.bootstrap.ci_snapshot_pusher_email

  images            = local.resolved_images
  api_read_public   = false
  api_read_invokers = ["user:joel@heisreal.today"]
}

# --- Adopt the SurrealDB secrets created by hand on 2026-09-27 ---------------
import {
  for_each = toset([
    "surreal-root-password",
    "surreal-api-read-password",
    "surreal-api-write-password",
    "surreal-api-admin-password",
    "surreal-workflow-password",
    "surreal-backup-password",
    "surreal-migrator-password",
  ])
  to = module.gcp.google_secret_manager_secret.surreal[each.value]
  id = "projects/heisreal-dev/secrets/${each.value}"
}

output "gcp" {
  value = module.gcp
}
