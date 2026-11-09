# The organisation-wide UK settings (heisreal.today: every project in it, dev and prod alike):
# Google refuses to create a resource outside the UK (D102), and new projects' log buckets start
# in London (D104). Turned on by Joel on 2026-11-08 (decision doc "org setup and picture/video",
# O1), ending their postponement (D119).
#
# Not under live/dev: these settings belong to no environment, and only this root may set them,
# so a prod copy of live/dev can't carry a second one. Its location check blocks (tf.sh). Its
# state sits in dev's state bucket (prefix org/), encrypted with tofu-state. Applied locally only,
# by an organisation admin listed in `admins`, with their own credentials (tf.sh refuses any
# other identity); CI validates it but never plans or applies it. The first apply has three
# steps: infra/terraform/README.md, "Where data lives".

terraform {
  required_version = ">= 1.11"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.5"
    }
  }
}

# Organisation-level APIs called with user credentials need a quota project.
provider "google" {
  region = "europe-west2"

  user_project_override = true
  billing_project       = "heisreal-dev"
}

module "org" {
  source = "../../modules/org"

  org_id               = "463617123121"
  allowed_locations    = ["in:gb-locations"]
  log_storage_location = "europe-west2"

  admins = [
    "user:joel@heisreal.today",
  ]
}

# The organisation's log settings always exist; adopt them rather than create.
import {
  to = module.org.google_logging_organization_settings.this
  id = "organizations/463617123121/settings"
}

# Granted by hand before this root existed.
import {
  for_each = toset(["user:joel@heisreal.today"])
  to       = module.org.google_organization_iam_member.policy_admin[each.value]
  id       = "463617123121 roles/orgpolicy.policyAdmin ${each.value}"
}

output "org" {
  value = module.org
}
