# Bootstrap for the dev environment: project, APIs, Terraform state bucket,
# CI identities, the budget and log storage. Applied by a developer (needs billing-account
# permissions for the budget); never by CI. The organisation-wide settings (modules/org) are
# postponed (D119), so this root needs no organisation roles.
#
# First run ever: see infra/terraform/README.md "Bootstrapping a new environment"
# (state starts local, then moves into the bucket this root creates).

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

# Only for the budget: the Billing Budgets API needs a quota project when called
# with user credentials. Not used elsewhere, because a fresh project can't
# serve as its own quota project until its APIs are enabled (by this root).
provider "google" {
  alias   = "billing"
  project = "heisreal-dev"
  region  = "europe-west2"

  user_project_override = true
  billing_project       = "heisreal-dev"
}

module "bootstrap" {
  source = "../../../modules/bootstrap"
  providers = {
    google         = google
    google.billing = google.billing
  }

  project_id      = "heisreal-dev"
  project_name    = "He Is Real dev"
  environment     = "dev"
  org_id          = "463617123121"
  billing_account = "01803E-B00849-FA2416"
  region          = "europe-west2"

  github_repository    = "He-Is-Real/monorepo"
  github_repository_id = "1390930896"

  budget_amount          = 15
  budget_alert_fractions = [0.2, 0.5] # emails at 3 and 7.50 (15 is always added)

  developers = [
    "user:joel@heisreal.today",
  ]
}

# D119 (Joel, 2026-10-30): the organisation-wide UK settings (D102, D104) are postponed until
# the organisation admin's one-time setup, a gate before Go live (infra/terraform/README.md,
# "Where data lives"). If anything of module.org reached this state, OpenTofu forgets it and
# Google keeps it; if nothing did, this block does nothing. Don't delete it before checking
# `tf.sh bootstrap state list` shows no module.org.
removed {
  from = module.org

  lifecycle {
    destroy = false
  }
}

# --- Adopt resources created by hand on 2026-09-27 -------------------------
import {
  to = module.bootstrap.google_project.this
  id = "heisreal-dev"
}

import {
  to = module.bootstrap.google_project_service.this["secretmanager.googleapis.com"]
  id = "heisreal-dev/secretmanager.googleapis.com"
}

import {
  for_each = toset(["user:joel@heisreal.today"])
  to       = module.bootstrap.google_project_iam_member.developers_owner[each.value]
  id       = "heisreal-dev roles/owner ${each.value}"
}

# --- Adopt Google's _Default log sink (D101: it now writes to London) -------
import {
  to = module.bootstrap.google_logging_project_sink.default
  id = "projects/heisreal-dev/sinks/_Default"
}

output "bootstrap" {
  value = module.bootstrap
}
