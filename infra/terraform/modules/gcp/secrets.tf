# SurrealDB passwords. Values are generated ephemerally and sent with
# write-only attributes, so they never appear in Terraform state or plans.
# Bump var.secret_rotation to rotate the service users, var.root_secret_rotation
# for root (separately: an existing database keeps its old root password until
# told, see infra/k8s/surrealdb/README.md).
#
# A rotation replaces the version resource. ABANDON keeps the previous version
# enabled in Secret Manager instead of destroying it first, so the old root
# password can still be read to tell the database about the new one.

resource "google_secret_manager_secret" "surreal" {
  for_each = toset(local.surreal_secret_names)

  project   = var.project_id
  secret_id = each.value
  labels    = merge(local.labels, { component = "surrealdb" })

  replication {
    user_managed {
      replicas {
        location = var.region # GDPR: stays in the UK
      }
    }
  }
}

ephemeral "random_password" "surreal" {
  for_each = toset(local.surreal_secret_names)

  length  = 40
  special = false
}

resource "google_secret_manager_secret_version" "surreal" {
  for_each = toset(local.surreal_secret_names)

  secret                 = google_secret_manager_secret.surreal[each.value].id
  secret_data_wo         = ephemeral.random_password.surreal[each.value].result
  secret_data_wo_version = each.value == "surreal-root-password" ? var.root_secret_rotation : var.secret_rotation
  deletion_policy        = "ABANDON"
}

# External Secrets Operator (in-cluster) reads every SurrealDB secret.
resource "google_service_account" "surrealdb_secrets" {
  project      = var.project_id
  account_id   = "surrealdb-secrets"
  display_name = "External Secrets Operator: SurrealDB secrets"
}

resource "google_secret_manager_secret_iam_member" "surrealdb_secrets" {
  for_each = google_secret_manager_secret.surreal

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.surrealdb_secrets.member
}

resource "google_service_account_iam_member" "surrealdb_secrets_wi" {
  service_account_id = google_service_account.surrealdb_secrets.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${local.wi_pool}[database/surrealdb-secrets]"
  depends_on         = [google_container_cluster.this] # creates the identity pool
}

# Clerk's Backend API secret key (decisions 4 and 13). Terraform owns the
# container; the value is human-supplied from the Clerk CLI as a new version
# (runbook: infra/clerk/README.md). api-user and api-admin verify session tokens
# without the network against the pinned public key. Three read it: api-user, to
# delete an erased person's Clerk account (M2 plan PR 11, D39, D81); the nightly
# housekeeping, to retry such a deletion that failed (housekeeping.tf); and
# api-admin, to set staff roles from the Staff page and put the baseline admins
# back on each start (M3, G8 B and S-4, Joel 2026-11-11).
resource "google_secret_manager_secret" "clerk_secret_key" {
  project   = var.project_id
  secret_id = "clerk-secret-key"
  labels    = merge(local.labels, { component = "clerk" })

  replication {
    user_managed {
      replicas {
        location = var.region # GDPR: stays in the UK
      }
    }
  }
}

# The signing secret (whsec_…) of Clerk's webhook endpoint for api-user's
# POST /v1/webhooks/clerk (user.deleted → erasure, D39). The owner creates the
# endpoint in Clerk's dashboard and adds the secret as a version
# (infra/clerk/README.md, "Webhook"); api-user reads it when a webhook comes, and
# again every five minutes, so until then webhooks answer 503 and Svix retries.
resource "google_secret_manager_secret" "clerk_webhook_signing_secret" {
  project   = var.project_id
  secret_id = "clerk-webhook-signing-secret"
  labels    = merge(local.labels, { component = "clerk" })

  replication {
    user_managed {
      replicas {
        location = var.region # GDPR: stays in the UK
      }
    }
  }
}

# api-user reads both Clerk secrets (erasure, D81: account deletion is one of the
# server jobs that may use Clerk's secret key).
resource "google_secret_manager_secret_iam_member" "api_user_clerk" {
  for_each = {
    key     = google_secret_manager_secret.clerk_secret_key.secret_id
    webhook = google_secret_manager_secret.clerk_webhook_signing_secret.secret_id
  }

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.signed_in_api["api-user"].member
}

# api-admin reads Clerk's secret key only (never the webhook's signing secret):
# staff roles live on the Clerk user's publicMetadata.role, and the Staff page
# writes them there first (G8 B, Joel 2026-11-11: "just code in the api service
# to hit clerk and update the db on change").
resource "google_secret_manager_secret_iam_member" "api_admin_clerk_key" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.clerk_secret_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.signed_in_api["api-admin"].member
}

# The website key (rate limiting, RL-8 A, Joel 2026-11-21): web's server sends it to
# api-public-read, which then counts web's calls in one large shared allowance instead of as one
# visitor's address. Generated ephemerally and sent write-only, so it never appears in state or
# plans. web gets it as an environment variable from Secret Manager (pinned to this version, so
# a rotation gives web a new revision in the same apply); api-public-read reads the latest
# version through libs/secrets, again every five minutes. Bump var.website_key_rotation to
# rotate: for up to five minutes a copy of api-public-read may still hold the old key and count
# web's calls per address.
resource "google_secret_manager_secret" "website_key" {
  project   = var.project_id
  secret_id = "website-key"
  labels    = merge(local.labels, { component = "rate-limits" })

  replication {
    user_managed {
      replicas {
        location = var.region # GDPR: stays in the UK
      }
    }
  }
}

ephemeral "random_password" "website_key" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret_version" "website_key" {
  secret                 = google_secret_manager_secret.website_key.id
  secret_data_wo         = ephemeral.random_password.website_key.result
  secret_data_wo_version = var.website_key_rotation
}

resource "google_secret_manager_secret_iam_member" "website_key" {
  for_each = {
    web             = google_service_account.web.member
    api-public-read = google_service_account.api_public_read.member
  }

  project   = var.project_id
  secret_id = google_secret_manager_secret.website_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}

# The logs' HMAC keys (logging build, decision doc logging.html: LG-2d and round 6). `log-hmac`
# makes the `hk1:` keyed hashes on every event (the session id, the token, long text such as
# story text and transcripts); `log-search-hmac` makes the `hs1:` hashes of who searched, on
# search events only, and nothing else, so the two never line up. Generated ephemerally and sent
# write-only, so neither value is ever in state or plans. Each service gets the secrets' names
# (`LOG_HMAC_SECRET`, `LOG_SEARCH_HMAC_SECRET`) and reads the latest versions at start-up through
# libs/secrets (libs/http's LogKeysModule); a named key it can't read stops it starting. Changing
# a key changes every hash after it, so a new key comes with a new prefix in libs/logging (`hk2:`,
# `hs2:`) and a bump of var.log_hmac_rotation in the same PR.
locals {
  log_hmac_secrets = toset(["log-hmac", "log-search-hmac"])

  # The env vars that name them, on every service that writes wide events.
  log_hmac_env = {
    LOG_HMAC_SECRET        = "log-hmac"
    LOG_SEARCH_HMAC_SECRET = "log-search-hmac"
  }

  # Who reads both keys: the APIs, cert-signer and web (libs/http's wide events), and the media
  # worker, its result writer and housekeeping (job events). Those last four exist only with media
  # ready, worker identity or housekeeping on.
  log_hmac_reader_members = merge(
    {
      api-public-read = google_service_account.api_public_read.member
      api-user        = google_service_account.signed_in_api["api-user"].member
      api-admin       = google_service_account.signed_in_api["api-admin"].member
      web             = google_service_account.web.member
    },
    local.worker_identity ? { cert-signer = google_service_account.cert_signer[0].member } : {},
    local.media_ready ? {
      media-worker = google_service_account.media_worker[0].member
      workflow     = google_service_account.result_writer[0].member
    } : {},
    var.housekeeping == null ? {} : { housekeeping = google_service_account.housekeeping[0].member },
  )
  log_hmac_readers = {
    for pair in setproduct(local.log_hmac_secrets, keys(local.log_hmac_reader_members)) :
    "${pair[0]}/${pair[1]}" => { secret = pair[0], member = local.log_hmac_reader_members[pair[1]] }
  }
}

resource "google_secret_manager_secret" "log_hmac" {
  for_each = local.log_hmac_secrets

  project   = var.project_id
  secret_id = each.value
  labels    = merge(local.labels, { component = "logging" })

  replication {
    user_managed {
      replicas {
        location = var.region # GDPR: stays in the UK
      }
    }
  }
}

ephemeral "random_password" "log_hmac" {
  for_each = local.log_hmac_secrets

  length  = 64
  special = false
}

resource "google_secret_manager_secret_version" "log_hmac" {
  for_each = local.log_hmac_secrets

  secret                 = google_secret_manager_secret.log_hmac[each.value].id
  secret_data_wo         = ephemeral.random_password.log_hmac[each.value].result
  secret_data_wo_version = var.log_hmac_rotation
}

resource "google_secret_manager_secret_iam_member" "log_hmac" {
  for_each = local.log_hmac_readers

  project   = var.project_id
  secret_id = google_secret_manager_secret.log_hmac[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value.member
}
