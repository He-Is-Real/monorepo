# Axiom, where every log entry also goes (LG-3, LG-5, LG-8; libs/logging/src/axiom.ts): Joel's
# free (Personal) organisation "He Is Real" (id he-is-real-uuwg), default edge deployment EU
# Central 1 (AWS). Applied like stripe, as tf-deployer:
#
#   tools/scripts/tf.sh axiom init
#   tools/scripts/tf.sh axiom plan
#   tools/scripts/tf.sh axiom apply
#
# Never planned on pull requests (tf-planner can't read the token); tofu-apply.yml plans it on
# main in wave 1, under the same approval as gcp, bunny and stripe, and tofu-drift.yml checks it
# weekly. The state holds the dataset's settings only, never a token.
#
# API tokens are never managed here: an `axiom_token` resource would put the token's value in
# state. They are made by hand in Axiom (docs/tooling-and-accounts.md, "Axiom").

terraform {
  required_version = ">= 1.11"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.5"
    }
    axiom = {
      source  = "axiomhq/axiom"
      version = "~> 1.10.0"
    }
  }
}

provider "google" {
  project = "heisreal-dev"
  region  = "europe-west2"
}

# Advanced token `heisreal-terraform` (Axiom's "Terraform" preset), read from Secret Manager for
# this run only: ephemeral, so it's never written to state or plan files. The secret is created by
# the bootstrap root, which lets tf-deployer read it; Joel adds the value (infra/terraform/README.md,
# "Axiom (logs)").
ephemeral "google_secret_manager_secret_version" "axiom_terraform_token" {
  project = "heisreal-dev"
  secret  = "axiom-terraform-token"
}

# The management API is api.axiom.co for every organisation, whatever its edge deployment: only
# ingest and queries go to the edge (Axiom docs, "Edge deployments"). An advanced token belongs to
# one organisation, so the provider needs no organisation id.
provider "axiom" {
  api_token = trimspace(ephemeral.google_secret_manager_secret_version.axiom_terraform_token.secret_data)
  base_url  = "https://api.axiom.co"
}

locals {
  # The organisation's default edge deployment (Settings → General): EU Central 1 (AWS). The free
  # plan has no UK edge (README, "Where data lives"). A dataset's edge can't change after creation.
  edge_deployment = "cloud.eu-central-1.aws"
}

# One dataset per environment (later heisreal-prod, in its own root). Made by hand on 2026-11-25
# and adopted here; settings exactly as made: events, 30 days.
import {
  to = axiom_dataset.logs
  id = "heisreal-dev"
}

resource "axiom_dataset" "logs" {
  name                 = "heisreal-dev"
  kind                 = "axiom:events:v1"
  edge_deployment      = local.edge_deployment
  use_retention_period = true
  retention_days       = 30 # LG-6 A: every event kept for 30 days, no sampling
}

# Dashboards, monitors and notifiers come here later (axiom_dashboard, axiom_monitor,
# axiom_notifier), once Joel has chosen what to watch and who gets told. Stats group by route,
# service, outcome, action or day only, never by person, story or address (LG-8).
