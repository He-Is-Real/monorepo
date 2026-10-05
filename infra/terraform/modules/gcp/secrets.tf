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
  for_each = toset(var.surreal_secret_names)

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
  for_each = toset(var.surreal_secret_names)

  length  = 40
  special = false
}

resource "google_secret_manager_secret_version" "surreal" {
  for_each = toset(var.surreal_secret_names)

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
