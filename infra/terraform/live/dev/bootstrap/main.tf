# Bootstrap for the dev environment: project, APIs, Terraform state bucket,
# CI identities and the budget. Applied by a developer (needs billing-account
# permissions for the budget); never by CI.
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

  budget_amount          = 10
  budget_alert_fractions = [0.2, 0.5] # emails at 2 and 5 (10 is always added)

  developers = [
    "user:joel@heisreal.today",
  ]
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

output "bootstrap" {
  value = module.bootstrap
}
