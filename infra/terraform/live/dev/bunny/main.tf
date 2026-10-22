# Dev Bunny.net: a Stream library (video/audio), an S3-compatible storage zone
# in London and a pull zone (CDN) in front of it (images). Applied with
# tools/scripts/tf.sh, as tf-bunny by default (TF_SH_IDENTITY=self for your own
# credentials):
#
#   tools/scripts/tf.sh bunny init
#   tools/scripts/tf.sh bunny plan
#   tools/scripts/tf.sh bunny apply
#
# This root's state holds Bunny keys (the approved exception in AGENTS.md). CI
# plans it only on main (tofu-apply.yml, tofu-drift.yml), never in PRs, and
# never prints its raw output; nothing reads its state. State and saved plans
# are encrypted with the tofu-bunny key, which only developers and tf-bunny can
# use (modules/bootstrap/kms.tf).

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

# Never public (D57 C): refuse to plan if allUsers or allAuthenticatedUsers holds
# any role on the state bucket, the project, the KMS keyring, either key or a
# `bunny-*` secret (modules/bunny-state-guard, tested offline). Who else has
# access is bootstrap's job; org-level grants: tools/scripts/check-bunny-fences.sh.
# tf-bunny reads these policies through roles/iam.securityReviewer.
data "google_storage_bucket_iam_policy" "tfstate" {
  bucket = "heisreal-dev-tfstate"
}

data "google_project_iam_policy" "project" {
  project = "heisreal-dev"
}

data "google_secret_manager_secrets" "all" {
  project = "heisreal-dev"
}

locals {
  bunny_secrets = [
    for s in data.google_secret_manager_secrets.all.secrets : s.secret_id if startswith(s.secret_id, "bunny-")
  ]
}

data "google_secret_manager_secret_iam_policy" "bunny" {
  for_each = toset(local.bunny_secrets)

  project   = "heisreal-dev"
  secret_id = each.value
}

data "google_kms_key_ring_iam_policy" "tofu" {
  key_ring_id = "projects/heisreal-dev/locations/europe-west2/keyRings/tofu"
}

data "google_kms_crypto_key_iam_policy" "key" {
  for_each = toset(["tofu-state", "tofu-bunny"])

  crypto_key_id = "projects/heisreal-dev/locations/europe-west2/keyRings/tofu/cryptoKeys/${each.value}"
}

module "never_public" {
  source = "../../../modules/bunny-state-guard"

  policies = merge(
    {
      bucket  = try(jsondecode(data.google_storage_bucket_iam_policy.tfstate.policy_data).bindings, [])
      project = try(jsondecode(data.google_project_iam_policy.project.policy_data).bindings, [])
      keyring = try(jsondecode(data.google_kms_key_ring_iam_policy.tofu.policy_data).bindings, [])
    },
    { for k, d in data.google_kms_crypto_key_iam_policy.key : "key/${k}" => try(jsondecode(d.policy_data).bindings, []) },
    { for k, d in data.google_secret_manager_secret_iam_policy.bunny : "secret/${k}" => try(jsondecode(d.policy_data).bindings, []) },
  )
}

moved {
  from = terraform_data.state_is_private
  to   = terraform_data.never_public
}

resource "terraform_data" "never_public" {
  lifecycle {
    precondition {
      condition     = length(module.never_public.public_grants) == 0
      error_message = "Public access found: ${join(", ", module.never_public.public_grants)}. Remove it through OpenTofu (bootstrap or this root) before planning Bunny."
    }
    # Fails closed if the listing is wrong (e.g. missing permission or a filter).
    precondition {
      condition     = contains(local.bunny_secrets, "bunny-account-api-key")
      error_message = "Couldn't list the bunny-* secrets; refusing to plan."
    }
  }
}

module "bunny" {
  source = "../../../modules/bunny"

  project_id  = "heisreal-dev"
  environment = "dev"
  region      = "europe-west2"

  depends_on = [terraform_data.never_public]
}

output "bunny" {
  value = module.bunny
}
