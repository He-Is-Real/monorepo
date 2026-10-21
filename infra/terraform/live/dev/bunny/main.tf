# Dev Bunny.net: a Stream library (video/audio), an S3-compatible storage zone
# in London and a pull zone (CDN) in front of it (images). Applied by a
# developer only, after bootstrap and gcp, with tools/scripts/tf-bunny.sh:
#
#   tools/scripts/tf-bunny.sh init
#   tools/scripts/tf-bunny.sh plan
#   tools/scripts/tf-bunny.sh apply
#
# This root's state holds Bunny keys (the approved exception in AGENTS.md), so
# CI neither plans nor applies it, nothing reads its state, and plans are never
# saved to files (a saved plan holds the same keys in clear text).

terraform {
  required_version = ">= 1.11"
  required_providers {
    bunnynet = {
      source  = "BunnyWay/bunnynet"
      version = "~> 0.19"
    }
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

# The account API key, read from Secret Manager with your own Google login for
# this run only: ephemeral, so it's never written to state or plan files.
# Created by the gcp root; the value is added by a developer (README, "Bunny.net").
ephemeral "google_secret_manager_secret_version" "bunny_account_api_key" {
  project = "heisreal-dev"
  secret  = "bunny-account-api-key"
}

provider "bunnynet" {
  api_key = ephemeral.google_secret_manager_secret_version.bunny_account_api_key.secret_data
}

# Refuse to write keys into state that CI could read: the state bucket must
# exclude this root's prefix from every CI identity (bootstrap, state.tf).
data "google_storage_bucket_iam_policy" "tfstate" {
  bucket = "heisreal-dev-tfstate"
}

locals {
  state_prefix     = "projects/_/buckets/heisreal-dev-tfstate/objects/dev/bunny/"
  tfstate_bindings = jsondecode(data.google_storage_bucket_iam_policy.tfstate.policy_data).bindings
  # Every binding on the bucket (CI identities only; developers have project-level storage.admin)
  # must carry the condition that excludes this prefix.
  state_is_private = alltrue([
    for b in local.tfstate_bindings :
    strcontains(try(b.condition.expression, ""), "!resource.name.startsWith('${local.state_prefix}')")
  ])
}

resource "terraform_data" "state_is_private" {
  lifecycle {
    precondition {
      condition     = local.state_is_private
      error_message = "gs://heisreal-dev-tfstate still lets a CI identity read dev/bunny/. Apply the bootstrap root first (modules/bootstrap/state.tf)."
    }
  }
}

module "bunny" {
  source = "../../../modules/bunny"

  project_id  = "heisreal-dev"
  environment = "dev"
  region      = "europe-west2"

  depends_on = [terraform_data.state_is_private]
}

output "bunny" {
  value = module.bunny
}
