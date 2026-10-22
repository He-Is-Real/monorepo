# OpenTofu state for every root in this environment (bootstrap, gcp, images, cluster, bunny),
# separated by prefix, encrypted with the KMS keys in kms.tf. Versioned so any past state can be recovered.
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

  # Saved plans from tofu-apply.yml that were never approved (gcp, images, cluster).
  lifecycle_rule {
    condition {
      age            = 7
      matches_prefix = ["plans/"]
    }
    action {
      type = "Delete"
    }
  }

  # The bunny root's saved plans and raw CI output (tofu-apply.yml, tofu-drift.yml). Cleanup
  # only: with versioning and soft delete they're recoverable for about two more weeks.
  lifecycle_rule {
    condition {
      age = 7
      matches_prefix = [
        "${var.environment}/bunny/plans/",
        "${var.environment}/bunny/logs/",
      ]
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
#
# The bunny root's state is the one exception to "state holds no secrets": the
# Bunny provider keeps the Stream library keys, the storage zone passwords and
# the pull zone's token key there. CI identities other than tf-bunny get nothing
# under its prefix (objects or lock), so only developers and tf-bunny can read
# it; it's also encrypted with tofu-bunny, which only they can use (kms.tf).
# Object names stay listable, contents don't. live/dev/bunny refuses to plan if
# anything Bunny is public.
locals {
  # Prefixes no CI identity but tf-bunny may read or write (keep in step with live/dev/bunny).
  private_state_prefixes = ["${var.environment}/bunny/"]
  ci_state_condition = join(" && ", [
    for p in local.private_state_prefixes :
    "!resource.name.startsWith('projects/_/buckets/${google_storage_bucket.tfstate.name}/objects/${p}')"
  ])
}

data "google_iam_policy" "tfstate" {
  binding {
    role    = "roles/storage.objectAdmin"
    members = [google_service_account.tf_deployer.member]
    condition {
      title       = "not-private-state"
      description = "No access to state that holds secrets (the bunny root)."
      expression  = local.ci_state_condition
    }
  }
  binding {
    role = "roles/storage.objectViewer"
    members = [
      google_service_account.tf_planner.member,
      google_service_account.tf_cluster_planner.member, # cluster + gcp state (remote state)
    ]
    condition {
      title       = "not-private-state"
      description = "No access to state that holds secrets (the bunny root)."
      expression  = local.ci_state_condition
    }
  }
  # The bucket-type clause lets the backend list object names (workspaces); object
  # permissions are checked on the object, so other roots' contents stay closed.
  binding {
    role    = "roles/storage.objectAdmin"
    members = [google_service_account.tf_bunny.member]
    condition {
      title       = "only-bunny-state"
      description = "The bunny root's state, plans and logs only."
      expression = join(" || ", [
        "resource.type == 'storage.googleapis.com/Bucket'",
        join(" || ", [
          for p in local.private_state_prefixes :
          "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.tfstate.name}/objects/${p}')"
        ]),
      ])
    }
  }
  # The bootstrap drift plan refreshes the bucket itself (storage.buckets.get).
  binding {
    role    = "roles/storage.bucketViewer"
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
