# Bootstrap for the dev environment: project, APIs, Terraform state bucket,
# CI identities, the budget, log storage and the organisation's settings. Applied by a developer (needs billing-account
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

  budget_amount          = 15
  budget_alert_fractions = [0.2, 0.5] # emails at 3 and 7.50 (15 is always added)

  developers = [
    "user:joel@heisreal.today",
  ]
}

# Organisation-wide (every project in heisreal.today, prod included): UK locations only (D102)
# and London as new projects' default log location (D104). Only this root may call the module.
# Needs organisation roles a developer gets once from the organisation admin (README,
# "Where data lives").
module "org" {
  source = "../../../modules/org"

  org_id               = "463617123121"
  allowed_locations    = ["in:gb-locations"] # the UK: today London (europe-west2) and its zones
  log_storage_location = "europe-west2"

  # The Org Policy API is enabled in this project (module.bootstrap), which bills the calls.
  depends_on = [module.bootstrap]
}

# The organisation's log settings always exist; adopt them before changing them.
import {
  to = module.org.google_logging_organization_settings.this
  id = "organizations/463617123121/settings"
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

output "org" {
  value = module.org
}
