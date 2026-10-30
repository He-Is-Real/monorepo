variable "project_id" {
  type = string
}

variable "environment" {
  description = "dev, prod, ..."
  type        = string
}

variable "region" {
  description = "Region for every regional resource. London only (UK data; D119's interim guard)."
  type        = string
  default     = "europe-west2"

  validation {
    condition     = var.region == "europe-west2"
    error_message = "Data stays in the UK: region must be europe-west2 (London)."
  }
}

variable "network_cidrs" {
  description = "Address plan. The run subnet must be at least /26 (Cloud Run Direct VPC egress)."
  type = object({
    gke      = string
    pods     = string
    services = string
    run      = string
  })
  default = {
    gke      = "10.10.0.0/20"
    pods     = "10.20.0.0/17"
    services = "10.30.0.0/22"
    run      = "10.10.16.0/26"
  }
}

variable "cluster_dns_domain" {
  description = "Additive VPC-scope DNS domain: cluster Services resolve as <svc>.<ns>.svc.<domain> anywhere in the VPC (lets Cloud Run reach SurrealDB without a load balancer). Autopilot: creation-time only."
  type        = string
}

variable "deletion_protection" {
  description = "Protect the GKE cluster from terraform destroy."
  type        = bool
  default     = true
}

variable "run_deletion_protection" {
  description = "Protect the Cloud Run services from terraform destroy. Set to false and apply before replacing a service (e.g. a rename): the provider refuses to delete a protected one."
  type        = bool
  default     = true
}

variable "ci_snapshot_pusher_email" {
  description = "Service account the snapshot workflow uses to push to apps-scratch (from the bootstrap root)."
  type        = string
}

variable "ci_image_pusher_email" {
  description = "Service account CI uses to push images (from the bootstrap root)."
  type        = string
}

variable "surreal_secret_names" {
  description = "Secret Manager secrets holding SurrealDB passwords: root, one per service login (D13 B service records) and the migrator/backup system users."
  type        = list(string)
  default = [
    "surreal-root-password",
    "surreal-api-public-read-password",
    "surreal-api-user-password",
    "surreal-api-admin-password",
    "surreal-workflow-password",
    "surreal-backup-password",
    "surreal-migrator-password",
  ]
}

variable "secret_rotation" {
  description = "Bump to rotate the SurrealDB service, migrator and backup passwords; the init Job then rewrites the service login hashes and system users on its next run (see infra/k8s/surrealdb/README.md)."
  type        = number
  default     = 1
}

variable "root_secret_rotation" {
  description = "Bump to rotate the SurrealDB root password. SurrealDB only reads it on first start, so an existing database must be told with the previous version: see infra/k8s/surrealdb/README.md 'Rotating passwords'."
  type        = number
  default     = 1
}

variable "images" {
  description = "Service -> image by digest (resolved by the live root). A missing service runs Google's placeholder hello image."
  type        = map(string)
  default     = {}
}

variable "api_public_read_max_instances" {
  description = "Scale-up cap for api-public-read on Cloud Run."
  type        = number
  default     = 2
}

variable "api_public_read_public" {
  description = "Allow unauthenticated calls to api-public-read (Cloud Run skips the invoker check; D31). Public since 0.9."
  type        = bool
  default     = false
}

variable "api_public_read_media" {
  description = <<-EOT
    D52: what api-public-read needs to sign Bunny media links. Identifiers only;
    the keys stay in the bunny-* secrets named here, which the bunny root
    creates and lets api-public-read read. null = signing off (media URLs are
    null). Set it only after the bunny root has applied: a revision that can't
    read its keys doesn't start.
  EOT
  type = object({
    stream_library_id       = string
    stream_cdn_hostname     = string
    images_cdn_hostname     = string
    stream_token_key_secret = optional(string, "bunny-stream-token-key")
    images_token_key_secret = optional(string, "bunny-images-token-key")
  })
  default = null
  validation {
    condition = var.api_public_read_media == null || (
      can(regex("^[0-9]{1,12}$", var.api_public_read_media.stream_library_id)) &&
      can(regex("^[a-z0-9-]+(\\.[a-z0-9-]+)+$", var.api_public_read_media.stream_cdn_hostname)) &&
      can(regex("^[a-z0-9-]+(\\.[a-z0-9-]+)+$", var.api_public_read_media.images_cdn_hostname)) &&
      can(regex("^bunny-[a-z0-9-]+$", var.api_public_read_media.stream_token_key_secret)) &&
      can(regex("^bunny-[a-z0-9-]+$", var.api_public_read_media.images_token_key_secret))
    )
    error_message = "api_public_read_media: a numeric library id, bare hostnames, and bunny-* secret names."
  }
}

variable "api_user_media_signing" {
  description = <<-EOT
    Hearts (M2): api-user signs the media links on the story cards of a person's
    favourites, with the same settings and keys as api-public-read
    (api_public_read_media, which must be set). The bunny root must already let
    api-user read the two token auth keys (signing_key_readers): a revision that
    can't read them doesn't start. false = api-user's cards carry no media links.
  EOT
  type        = bool
  default     = false
  validation {
    condition     = !var.api_user_media_signing || var.api_public_read_media != null
    error_message = "api_user_media_signing needs api_public_read_media (the identifiers and secret names it reuses)."
  }
}

variable "site_videos" {
  description = <<-EOT
    Site videos (not stories) api-public-read signs player links for, by key: the
    Bunny Stream video GUID in the library's `site-assets` collection, uploaded with
    tools/scripts/site-asset-upload.mjs. Only the keys api-public-read knows
    (founder-intro, next-steps); each becomes SITE_VIDEO_<KEY>. Needs api_public_read_media
    (the same library and key). Empty = the pages show their placeholders.
  EOT
  type        = map(string)
  default     = {}
  validation {
    condition = alltrue([for k, guid in var.site_videos :
      contains(["founder-intro", "next-steps"], k) &&
      can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", guid))
    ])
    error_message = "site_videos: keys api-public-read knows (founder-intro, next-steps) and lowercase Bunny video GUIDs."
  }
  validation {
    condition     = length(var.site_videos) == 0 || var.api_public_read_media != null
    error_message = "site_videos needs api_public_read_media (the library and key that sign them)."
  }
}

variable "api_public_read_invokers" {
  description = "Members allowed to call api-public-read when it isn't public (e.g. user:someone@heisreal.today)."
  type        = list(string)
  default     = []
}

variable "signed_in_apis_max_instances" {
  description = "Scale-up cap for api-user and api-admin on Cloud Run (each)."
  type        = number
  default     = 2
}

variable "signed_in_apis_public" {
  description = "Allow unauthenticated calls to api-user and api-admin at the Cloud Run layer (the invoker check is skipped; the apps still require a Clerk session token on every route but /health). The browser calls them directly (D31), so they need it to be reachable."
  type        = bool
  default     = false
}

variable "signed_in_apis_invokers" {
  description = "Members allowed to call api-user and api-admin when they aren't public."
  type        = list(string)
  default     = []
}

variable "clerk_issuer" {
  description = "The Clerk instance's Frontend API origin, its session tokens' iss (api-user and api-admin's CLERK_ISSUER)."
  type        = string
  validation {
    condition     = can(regex("^https://[a-z0-9.-]+$", var.clerk_issuer))
    error_message = "clerk_issuer is the Clerk instance's https origin, without a path."
  }
}

variable "clerk_jwt_public_key" {
  description = "Clerk's PEM public key, the same one SurrealDB pins (cluster root's clerk.auto.tfvars). api-user and api-admin verify session tokens with it (CLERK_JWT_PUBLIC_KEY)."
  type        = string
  validation {
    condition = (
      startswith(trimspace(var.clerk_jwt_public_key), "-----BEGIN PUBLIC KEY-----") &&
      endswith(trimspace(var.clerk_jwt_public_key), "-----END PUBLIC KEY-----") &&
      !strcontains(var.clerk_jwt_public_key, "PRIVATE")
    )
    error_message = "clerk_jwt_public_key must be a PEM public key (-----BEGIN PUBLIC KEY-----)."
  }
}

variable "web_max_instances" {
  description = "Scale-up cap for web on Cloud Run."
  type        = number
  default     = 2
}

variable "web_public" {
  description = "Allow unauthenticated visits to web (Cloud Run skips the invoker check). Public since 0.9."
  type        = bool
  default     = false
}

variable "web_invokers" {
  description = "Members allowed to call web when it isn't public (browse with `gcloud run services proxy web`)."
  type        = list(string)
  default     = []
}

variable "clerk_publishable_key" {
  description = "The Clerk instance's publishable key (public; D32: web passes it to the browser). Empty = no sign-in control."
  type        = string
  default     = ""
  validation {
    condition     = var.clerk_publishable_key == "" || can(regex("^pk_(test|live)_[A-Za-z0-9]+$", var.clerk_publishable_key))
    error_message = "clerk_publishable_key must be a Clerk publishable key (pk_test_… or pk_live_…), never a secret key."
  }
}

variable "web_donations" {
  description = <<-EOT
    Stripe's Buy Buttons on /donate (Joel, 2026-10-29): the publishable key, the two buttons' IDs
    (made in the Stripe Dashboard from the stripe root's Payment Links) and the donor portal's
    login page (`tf.sh stripe output stripe`). All public by design. web shows the buttons only
    when the key and both IDs are set; otherwise its "giving isn't open yet" placeholder.
  EOT
  type = object({
    stripe_publishable_key = optional(string, "")
    one_off_button_id      = optional(string, "")
    monthly_button_id      = optional(string, "")
    donor_portal_url       = optional(string, "")
  })
  default  = {}
  nullable = false
  validation {
    condition     = var.web_donations.stripe_publishable_key == "" || can(regex("^pk_(test|live)_[A-Za-z0-9]+$", var.web_donations.stripe_publishable_key))
    error_message = "web_donations.stripe_publishable_key must be a Stripe publishable key (pk_test_… or pk_live_…), never a secret or restricted key."
  }
  validation {
    condition     = !startswith(var.web_donations.stripe_publishable_key, "pk_live_") || var.project_id != "heisreal-dev"
    error_message = "Dev takes no real money: web_donations needs Stripe's sandbox (pk_test_…) in heisreal-dev."
  }
  validation {
    condition = alltrue([for id in [var.web_donations.one_off_button_id, var.web_donations.monthly_button_id] :
    id == "" || can(regex("^buy_btn_[A-Za-z0-9]+$", id))])
    error_message = "The button IDs are Stripe Buy Button IDs (buy_btn_…)."
  }
  validation {
    condition     = var.web_donations.donor_portal_url == "" || can(regex("^https://billing\\.stripe\\.com/p/login/[A-Za-z0-9_]+$", var.web_donations.donor_portal_url))
    error_message = "donor_portal_url is Stripe's portal login page (https://billing.stripe.com/p/login/…)."
  }
}

variable "web_origins" {
  description = "web's origins (its Cloud Run URLs), allowed to call the APIs from the browser (CORS, D31) and, on api-user and api-admin, the allowed azp of Clerk session tokens. Passed in rather than read from the service, which would be a dependency cycle."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for o in var.web_origins : can(regex("^https://[a-z0-9.-]+$", o))])
    error_message = "web_origins are https origins without a path."
  }
}

variable "web_indexing" {
  description = "Invite search engines in (web's INDEXING=allow: no noindex, robots.txt allows crawling, /sitemap.xml exists). An explicit opt-in for Go live; off = noindex everywhere. Refused in dev."
  type        = bool
  default     = false
  nullable    = false
  validation {
    condition     = !var.web_indexing || var.project_id != "heisreal-dev"
    error_message = "web_indexing can't be turned on in dev (project heisreal-dev): dev holds dummy data and must stay out of search engines."
  }
  validation {
    condition     = !var.web_indexing || var.web_site_url != ""
    error_message = "web_indexing needs web_site_url (the canonical origin for URLs and the sitemap)."
  }
}

variable "web_site_url" {
  description = "web's public origin (canonical URLs, Open Graph, sitemap), e.g. https://www.heisreal.today. Empty: none, so no absolute URLs and no indexing."
  type        = string
  default     = ""
  # A DNS name whose last label starts with a letter (no IPs, ports, paths or trailing dot): the
  # same rule as web's siteUrl() (apps/web/src/lib/config.ts), so web never ignores it.
  validation {
    condition = var.web_site_url == "" || (
      length(var.web_site_url) <= 261 &&
      can(regex("^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$", var.web_site_url))
    )
    error_message = "web_site_url is an https origin with a DNS host name (no path, port, IP or trailing slash), or empty."
  }
}

variable "backup_retention_days" {
  description = "Delete database backups after this many days (GDPR erasure window)."
  type        = number
  default     = 30
}

variable "dev_seed" {
  description = "D49: the dev-seed Cloud Run Job that resets dev to the D47 dummy dataset, its service account and its database password (surreal-dev-seed-password; the cluster root's dev_seed_login creates the user). Dev only: refused unless the project is heisreal-dev."
  type        = bool
  default     = false
  nullable    = false
  validation {
    condition     = !var.dev_seed || var.project_id == "heisreal-dev"
    error_message = "dev_seed (D49) can only be set in dev (project heisreal-dev)."
  }
}

variable "ci_dev_seeder_email" {
  description = "D50: the CI identity (bootstrap root, ci-dev-seeder) allowed to start the dev-seed Job and watch its executions. Empty: none yet (bootstrap not applied)."
  type        = string
  default     = ""
}

variable "legal_documents_retention_locked" {
  description = "Lock the 100-year retention policy of both legal buckets (the privacy policy and terms PDFs of record, and their original uploads). Irreversible: once locked, the policy can't be shortened or removed, and a bucket can't be deleted until every object is 100 years old. Dev stays unlocked; every other environment must lock it (refused otherwise), before Real stories (D124)."
  type        = bool
  default     = false
  nullable    = false
  validation {
    condition     = var.legal_documents_retention_locked || var.environment == "dev"
    error_message = "legal_documents_retention_locked must be true outside dev: the privacy policy and terms people agreed to must be kept forever."
  }
}

variable "dev_legal_placeholders" {
  description = "Upload the placeholder privacy policy (libs/legal/dpa/dev_placeholder.pdf) and terms (libs/legal/terms/dev_placeholder.pdf) to the legal documents bucket as legal/<privacy|terms>/dev_placeholder/<sha256>.pdf. Dev only: refused unless environment is dev."
  type        = bool
  default     = false
  nullable    = false
  validation {
    condition     = !var.dev_legal_placeholders || var.environment == "dev"
    error_message = "dev_legal_placeholders can only be set in dev."
  }
}
