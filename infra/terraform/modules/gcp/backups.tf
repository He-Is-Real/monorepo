# Nightly SurrealDB exports (Article 9 data): UK only, private, deleted after
# backup_retention_days so GDPR erasure completes within that window.

resource "google_storage_bucket" "backups" {
  project                     = var.project_id
  name                        = "${var.project_id}-db-backups"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.labels

  lifecycle_rule {
    condition {
      age = var.backup_retention_days
    }
    action {
      type = "Delete"
    }
  }
}

resource "google_service_account" "surrealdb_backup" {
  project      = var.project_id
  account_id   = "surrealdb-backup"
  display_name = "SurrealDB backup CronJob"
}

# Authoritative: replaces the default "project viewers can read objects"
# bindings. The backup job may only create. Only developers can read backups
# (restores), through their project-level storage role from bootstrap.
data "google_iam_policy" "backups" {
  binding {
    role    = "roles/storage.objectCreator"
    members = [google_service_account.surrealdb_backup.member]
  }
}

resource "google_storage_bucket_iam_policy" "backups" {
  bucket      = google_storage_bucket.backups.name
  policy_data = data.google_iam_policy.backups.policy_data
}

resource "google_service_account_iam_member" "surrealdb_backup_wi" {
  service_account_id = google_service_account.surrealdb_backup.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${local.wi_pool}[database/surrealdb-backup]"
  depends_on         = [google_container_cluster.this]
}
