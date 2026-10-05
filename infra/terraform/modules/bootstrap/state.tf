# Terraform state for every root in this environment (bootstrap, gcp, images, cluster),
# separated by prefix. Versioned so any past state can be recovered.
resource "google_storage_bucket" "tfstate" {
  project                     = google_project.this.project_id
  name                        = "${var.project_id}-tfstate"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.labels

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  # Saved plans from terraform-apply.yml that were never approved.
  lifecycle_rule {
    condition {
      age            = 7
      matches_prefix = ["plans/"]
    }
    action {
      type = "Delete"
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.this]
}

# Authoritative: replaces the default "project viewers/editors can read/write
# objects" bindings, so only the CI identities below (and developers, through
# developers_storage) can touch state.
data "google_iam_policy" "tfstate" {
  binding {
    role    = "roles/storage.objectAdmin"
    members = [google_service_account.tf_deployer.member]
  }
  binding {
    role    = "roles/storage.objectViewer"
    members = [google_service_account.tf_planner.member]
  }
}

resource "google_storage_bucket_iam_policy" "tfstate" {
  bucket      = google_storage_bucket.tfstate.name
  policy_data = data.google_iam_policy.tfstate.policy_data
}

# Developers own the project (adopted: granted by hand when it was created).
resource "google_project_iam_member" "developers_owner" {
  for_each = toset(var.developers)

  project = google_project.this.project_id
  role    = "roles/owner"
  member  = each.value
}

# Developers manage every bucket and read state and backups. Explicit, because
# the buckets' policies are authoritative: the default bindings that gave
# project owners bucket access are gone.
resource "google_project_iam_member" "developers_storage" {
  for_each = toset(var.developers)

  project = google_project.this.project_id
  role    = "roles/storage.admin"
  member  = each.value
}
