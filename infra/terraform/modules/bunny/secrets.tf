# The keys the apps will need (api-user signs uploads in M2; workers later),
# copied into Secret Manager so apps read them only through libs/secrets. The
# values come from the Bunny resources and are sent with write-only attributes,
# so these resources add nothing to state. No accessor grants yet: the service
# accounts that read them arrive with the milestone that uses them.
#
# The version number is derived from the value, so a key rotated at Bunny
# (refreshed into state by the next plan) becomes a new secret version on the
# next apply. ABANDON keeps the previous version enabled until it's disabled
# by hand, so running services aren't cut off mid-rotation.

locals {
  # Names are listed separately so for_each never depends on the values.
  app_secret_ids = ["bunny-stream-api-key", "bunny-storage-password"]
  app_secrets = {
    # Create videos and sign TUS uploads (sha256(library + key + expiry + video)).
    "bunny-stream-api-key" = bunnynet_stream_library.media.api_key
    # S3 secret access key for presigned image uploads (access key = zone name).
    "bunny-storage-password" = bunnynet_storage_zone.images.password
  }
}

resource "google_secret_manager_secret" "app" {
  for_each = toset(local.app_secret_ids)

  project   = var.project_id
  secret_id = each.value
  labels = {
    app         = "heisreal"
    environment = var.environment
    managed-by  = "terraform"
    component   = "bunny"
  }

  replication {
    user_managed {
      replicas {
        location = var.region # GDPR: stays in the UK
      }
    }
  }
}

resource "google_secret_manager_secret_version" "app" {
  for_each = toset(local.app_secret_ids)

  secret                 = google_secret_manager_secret.app[each.value].id
  secret_data_wo         = local.app_secrets[each.value]
  secret_data_wo_version = parseint(substr(sha256(local.app_secrets[each.value]), 0, 12), 16)
  deletion_policy        = "ABANDON"
}
