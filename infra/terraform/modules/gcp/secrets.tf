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
# without the network against the pinned public key. Only api-user reads it, to
# delete an erased person's Clerk account (M2 plan PR 11, D39, D81); M3's role
# assignment adds api-admin then.
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
# (infra/clerk/README.md, "Webhook"); api-user reads it on the first webhook, so
# until then webhooks answer 503 and Svix retries.
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

# api-user alone reads both Clerk secrets (erasure, D81: account deletion is one
# of the three server jobs that may use Clerk's secret key).
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
