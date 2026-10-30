# Dev donations in Stripe's sandbox (Joel, 2026-10-29: Stripe's embeddable Buy Buttons, option A):
# the product, prices, Payment Links and donor portal in modules/stripe. Test mode only: the
# module refuses to plan with a live key. Applied like gcp, as tf-deployer:
#
#   tools/scripts/tf.sh stripe init
#   tools/scripts/tf.sh stripe plan
#   tools/scripts/tf.sh stripe apply
#
# Never planned on pull requests (tf-planner can't read the key); tofu-apply.yml plans it on main
# in wave 1. The state holds Stripe IDs and public URLs only, never the key.

terraform {
  required_version = ">= 1.11"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.5"
    }
    stripe = {
      source  = "stripe/stripe"
      version = "~> 0.3.0"
    }
  }
}

provider "google" {
  project = "heisreal-dev"
  region  = "europe-west2"
}

# A restricted sandbox key, read from Secret Manager for this run only: ephemeral, so it's never
# written to state or plan files. The secret is created by the bootstrap root, which lets
# tf-deployer read it; Joel adds the value (infra/terraform/README.md, "Stripe").
ephemeral "google_secret_manager_secret_version" "stripe_api_key" {
  project = "heisreal-dev"
  secret  = "stripe-api-key"
}

locals {
  api_key = trimspace(ephemeral.google_secret_manager_secret_version.stripe_api_key.secret_data)
}

provider "stripe" {
  api_key = local.api_key
}

module "stripe" {
  source = "../../../modules/stripe"

  environment = "dev"
  # Only the key's mode leaves this file; the module refuses anything but a test key.
  key_mode = can(regex("^(sk|rk)_live_", local.api_key)) ? "live" : (can(regex("^(sk|rk)_test_", local.api_key)) ? "test" : "unknown")
  site_url = "https://web-jbxp6odnsa-nw.a.run.app" # web_site_url in live/dev/gcp
}

# The Payment Links (make a Buy Button from each in the Dashboard) and the donor portal's login
# page. Public. `tf.sh stripe output stripe`.
output "stripe" {
  value = {
    payment_links    = module.stripe.payment_links
    donor_portal_url = module.stripe.donor_portal_url
  }
}
