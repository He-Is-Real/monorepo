# Dev GCP infrastructure: network, registry, GKE Autopilot, secrets, backups,
# and Cloud Run (api-public-read, api-user, api-admin and web, running the images
# chosen in images.auto.tfvars).

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

variable "run_deletion_protection" {
  description = "Set to false for one apply before replacing a Cloud Run service (e.g. a tainted one); the next plain apply turns it back on."
  type        = bool
  default     = true
}

variable "image_overrides" {
  description = "One-off overrides for a single apply, e.g. -var 'image_overrides={\"api-public-read\"=\"snapshot\"}'. The next apply without it returns to images.auto.tfvars."
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

variable "clerk_jwt_public_key" {
  description = "Clerk's PEM public key for api-user and api-admin. Set by clerk.auto.tfvars, a link to the cluster root's file, so SurrealDB and the services always pin the same key."
  type        = string
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

  images = local.resolved_images
  # Public since the walking-skeleton page (0.9, D31): Cloud Run's invoker check is off. Both
  # stay capped at 2 instances and scale to zero (budget, decision 10).
  api_public_read_public   = true
  api_public_read_invokers = []
  # D52: media signing, on since the bunny root applied its token auth keys and
  # api-public-read's access to them (#63; infra/terraform/README.md, "Media token auth").
  # Values: `tf.sh bunny output bunny`.
  api_public_read_media = {
    stream_library_id   = "789855"
    stream_cdn_hostname = "vz-bd66cea0-80b.b-cdn.net"
    images_cdn_hostname = "heisreal-dev-images.b-cdn.net"
  }
  # Hearts (M2): api-user signs the media links on favourites' cards with the same keys. Apply
  # the bunny root first (it lets api-user read them), or api-user's new revision won't start.
  api_user_media_signing = true
  # Video and audio uploads (M2 plan PR 7): api-user creates and signs Bunny Stream uploads with
  # the library key. The bunny root's upload_key_readers grant (#123) must be applied first.
  api_user_uploads = true
  # Image uploads (M2 plan PR 10): api-user signs S3 presigned PUTs to the images zone in London
  # with its password; the same upload_key_readers grant (#123) covers it.
  # Values: `tf.sh bunny output bunny` (storage_zone_name, storage_s3_hostname).
  api_user_image_uploads = {
    storage_zone = "heisreal-dev-image-store"
    s3_host      = "uk-s3.storage.bunnycdn.com"
    s3_region    = "uk"
  }
  # Site videos (not stories) api-public-read signs, by key: GUIDs from
  # tools/scripts/site-asset-upload.mjs (infra/terraform/README.md, "Site assets").
  site_videos = {
    founder-intro = "0cfd81a9-31a2-491b-90c4-7e7338025944"
    next-steps    = "992ad3c2-8f25-4081-b57c-fb54c64c2689"
  }
  # api-user and api-admin (M2): public at the Cloud Run layer like api-public-read, because the
  # browser calls them directly (D31); every route but /health needs a Clerk session token, which
  # the apps verify. Capped at 2 instances each and scale to zero.
  signed_in_apis_public   = true
  signed_in_apis_invokers = []
  web_public              = true
  web_invokers            = []
  # web's two generated URLs (project number and hash forms); CORS on the APIs (D31) and the
  # Clerk tokens' allowed azp on api-user and api-admin.
  web_origins = [
    "https://web-jbxp6odnsa-nw.a.run.app",
    "https://web-236063168938.europe-west2.run.app",
  ]
  # Not indexed: web_indexing stays off (the module refuses it in dev).
  web_site_url = "https://web-jbxp6odnsa-nw.a.run.app" # canonical URLs
  # The Clerk dev instance (D7: no production instance without our own domain). Public.
  clerk_publishable_key   = "pk_test_c3VwZXJiLW1pbmstODk2Ny5jbGVyay5hY2NvdW50cy5kZXYk"
  clerk_issuer            = "https://superb-mink-8967.clerk.accounts.dev"
  clerk_jwt_public_key    = var.clerk_jwt_public_key
  run_deletion_protection = var.run_deletion_protection

  # Stripe's Buy Buttons on /donate (Joel, 2026-10-29), in Stripe's sandbox. Public values, filled
  # in once Joel has made the two buttons in the Stripe Dashboard (infra/terraform/README.md,
  # "Stripe"): until then /donate shows "Giving isn't open yet".
  web_donations = {
    # Public by design. The buttons were made in the Stripe Dashboard (sandbox) from the stripe
    # root's Payment Links; the portal URL is `tf.sh stripe output stripe`: donor_portal_url.
    stripe_publishable_key = "pk_test_51UUWPqQXwDT04lZZ2Pnzk6NMRXSGrVvqBEQLB6ObZ1WJmd2XlaFxirg1HrhCXyFgChagB19OC0f8uGQ3aTR7sgTn00DEMppsdA"
    one_off_button_id      = "buy_btn_1UWO6mQXwDT04lZZVePFhYMh"
    monthly_button_id      = "buy_btn_1UWO7OQXwDT04lZZysSNapqq"
    donor_portal_url       = "https://billing.stripe.com/p/login/test_aFa8wR1Hv3lE8gk6Ly1wY00"
  }

  # D49/D50: the dev-seed Job (dev only) and who may start it. try(): until bootstrap is applied
  # with ci-dev-seeder, the Job exists but no CI identity may start it.
  dev_seed            = true
  ci_dev_seeder_email = try(local.bootstrap.ci_dev_seeder_email, "")

  # The nightly housekeeping Job (abandoned drafts, orphaned story videos), 03:30 London time.
  # Dry run first: it logs what it would delete; turn it off once a night's log looks right.
  # Needs bootstrap's Cloud Scheduler API and tf-deployer's scheduler role applied first.
  housekeeping = {
    schedule      = "30 3 * * *"
    dry_run       = true
    max_deletions = 50
  }
}

# --- Adopt the SurrealDB secrets created by hand on 2026-09-27 ---------------
import {
  for_each = toset([
    "surreal-root-password",
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
