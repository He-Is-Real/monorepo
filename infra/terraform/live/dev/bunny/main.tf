# Dev Bunny.net: a Stream library (video/audio), an S3-compatible storage zone
# in London and a pull zone (CDN) in front of it (images). Applied by a
# developer only, after bootstrap, with tools/scripts/tf.sh (as tf-bunny by default;
# TF_SH_IDENTITY=self for your own credentials):
#
#   tools/scripts/tf.sh bunny init
#   tools/scripts/tf.sh bunny plan
#   tools/scripts/tf.sh bunny apply
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
# Created by the bootstrap root; the value is added by a developer (README, "Bunny.net").
ephemeral "google_secret_manager_secret_version" "bunny_account_api_key" {
  project = "heisreal-dev"
  secret  = "bunny-account-api-key"
}

provider "bunnynet" {
  api_key = ephemeral.google_secret_manager_secret_version.bunny_account_api_key.secret_data
}

# Refuse to write keys anywhere CI could read them. The bootstrap root outputs
# the exact IAM conditions (no secrets in its state), and the live policies
# must carry exactly those:
# - every binding on the state bucket (CI identities only; developers have
#   project-level storage.admin) excludes this root's prefix (state.tf);
# - tf-deployer's secrets and buckets roles exclude `bunny-*` secrets and the
#   state bucket, so it can't grant itself access through their IAM (ci_identity.tf).
data "terraform_remote_state" "bootstrap" {
  backend = "gcs"
  config = {
    bucket = "heisreal-dev-tfstate"
    prefix = "dev/bootstrap"
  }
}

data "google_storage_bucket_iam_policy" "tfstate" {
  bucket = "heisreal-dev-tfstate"
}

data "google_project_iam_policy" "project" {
  project = "heisreal-dev"
}

locals {
  fences = try(data.terraform_remote_state.bootstrap.outputs.bootstrap.bunny_fences, null)

  tfstate_bindings = jsondecode(data.google_storage_bucket_iam_policy.tfstate.policy_data).bindings
  state_is_private = local.fences != null && alltrue([
    for b in local.tfstate_bindings :
    try(b.condition.expression, "") == local.fences.state_condition
  ])

  deployer_bindings = local.fences == null ? [] : [
    for b in jsondecode(data.google_project_iam_policy.project.policy_data).bindings : b
    if contains(keys(local.fences.deployer), b.role)
  ]
  # Every binding of those roles (there must be one per role) carries exactly the fence.
  deployer_is_fenced = local.fences != null && alltrue([
    for role, expression in local.fences.deployer : length([
      for b in local.deployer_bindings : b if b.role == role
      ]) > 0 && alltrue([
      for b in local.deployer_bindings : try(b.condition.expression, "") == expression if b.role == role
    ])
  ])
}

# Nobody else may hold storage.objects.get (which reads every bucket, whatever
# the bucket's own policy says) on the project or the organisation: only the
# developers and the verified Google service agents below
# (modules/bunny-state-guard, tested offline).
data "google_organization_iam_policy" "org" {
  org_id = "463617123121"
}

locals {
  project_number = try(data.terraform_remote_state.bootstrap.outputs.bootstrap.project_number, "unknown")

  # Google service agents that hold storage.objects.get here, verified 2026-10-21. Exact
  # addresses only: a new agent fails the guard until reviewed and added here.
  google_service_agents = [
    "serviceAccount:service-${local.project_number}@gcp-sa-cloudbuild.iam.gserviceaccount.com",
    "serviceAccount:service-${local.project_number}@gcf-admin-robot.iam.gserviceaccount.com",
    "serviceAccount:service-${local.project_number}@compute-system.iam.gserviceaccount.com",
    "serviceAccount:service-${local.project_number}@containerregistry.iam.gserviceaccount.com",
    "serviceAccount:service-${local.project_number}@serverless-robot-prod.iam.gserviceaccount.com",
  ]
}

module "state_readers" {
  source = "../../../modules/bunny-state-guard"

  project_id     = "heisreal-dev"
  state_readers  = try(local.fences.state_readers, [])
  service_agents = local.google_service_agents
  bindings = concat(
    jsondecode(data.google_project_iam_policy.project.policy_data).bindings,
    jsondecode(data.google_organization_iam_policy.org.policy_data).bindings,
  )
  role_permissions = { for r, d in data.google_iam_role.other : r => d.included_permissions }
}

data "google_iam_role" "other" {
  for_each = toset(module.state_readers.roles_to_check)
  name     = each.value
}

resource "terraform_data" "state_is_private" {
  lifecycle {
    precondition {
      condition     = local.state_is_private
      error_message = "gs://heisreal-dev-tfstate still lets a CI identity read dev/bunny/. Apply the bootstrap root first (modules/bootstrap/state.tf)."
    }
    precondition {
      condition     = local.fences != null && length(module.state_readers.object_readers) == 0
      error_message = "These principals can read every bucket, including this root's state: ${join(", ", module.state_readers.object_readers)}. Remove the grant (bootstrap). A developer goes in var.developers. A new Google service agent (service-<number>@<agent>.iam.gserviceaccount.com, never @heisreal-dev.iam...) must be reviewed, then added to local.google_service_agents."
    }
    precondition {
      condition     = local.deployer_is_fenced
      error_message = "tf-deployer's secrets/buckets roles aren't conditioned yet, so it could grant itself access to this root's state or keys. Apply the bootstrap root first (modules/bootstrap/ci_identity.tf)."
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
