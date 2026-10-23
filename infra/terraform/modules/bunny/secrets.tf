# The keys the apps need, copied into Secret Manager so apps read them only
# through libs/secrets. The values come from the Bunny resources and are sent
# with write-only attributes, so these resources add nothing to state. Accessor
# grants only for keys a deployed service uses: the two token auth keys, for
# api-public-read (D52). The upload keys get theirs with M2 (api-user).
#
# The version number is derived from the value, so a key rotated at Bunny
# (refreshed into state by the next plan) becomes a new secret version on the
# next apply. ABANDON keeps the previous version enabled until it's disabled
# by hand, so running services aren't cut off mid-rotation.

locals {
  # Names are listed separately so for_each never depends on the values.
  app_secret_ids = [
    "bunny-stream-api-key", "bunny-storage-password",
    "bunny-stream-token-key", "bunny-images-token-key",
  ]
  app_secrets = {
    # Create videos and sign TUS uploads (sha256(library + key + expiry + video)).
    "bunny-stream-api-key" = bunnynet_stream_library.media.api_key
    # S3 secret access key for presigned image uploads (access key = zone name).
    "bunny-storage-password" = bunnynet_storage_zone.images.password
    # D52: signs Stream player links and Stream CDN files (thumbnails). It's the
    # Stream pull zone's key; the data source doesn't mark it sensitive.
    "bunny-stream-token-key" = sensitive(data.bunnynet_pullzone.stream.token_auth_key)
    # D52: signs image links on the images pull zone.
    "bunny-images-token-key" = bunnynet_pullzone.images.token_auth_key
  }
  signing_key_ids = ["bunny-stream-token-key", "bunny-images-token-key"]
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

# D52: the services that sign media links read the two token auth keys, and no
# other bunny-* secret. tf-bunny manages these grants (tf_bunny.tf: only
# bunny-* secrets); the root's never-public guard checks them before each plan.
resource "google_secret_manager_secret_iam_member" "signing_key_readers" {
  for_each = {
    for pair in setproduct(local.signing_key_ids, var.signing_key_readers) :
    "${pair[0]} ${pair[1]}" => { secret = pair[0], member = pair[1] }
  }

  project   = var.project_id
  secret_id = google_secret_manager_secret.app[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value.member
}
