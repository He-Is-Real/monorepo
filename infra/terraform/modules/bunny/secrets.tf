# The keys the apps need, copied into Secret Manager so apps read them only
# through libs/secrets. The values come from the Bunny resources and are sent
# with write-only attributes, so these resources add nothing to state. Accessor
# grants only for keys a deployed service uses: the two token auth keys, for
# api-public-read (D52) and api-user (hearts' cards, M2), the two upload keys,
# for api-user alone (M2's uploads, D80), and the Stream library key for the
# nightly housekeeping Job (orphaned story videos, M2), and the library's
# read-only key for media ready (api-user checks Bunny's webhook signatures with
# it; the media worker reads a video's facts with it).
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
    "bunny-stream-readonly-key",
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
    # Media ready (M2 plan item 13): reads a video's facts, and is what Bunny
    # signs its webhooks with (HMAC-SHA256 of the body). It can't create,
    # change or delete anything.
    "bunny-stream-readonly-key" = bunnynet_stream_library.media.api_key_readonly
  }
  signing_key_ids = ["bunny-stream-token-key", "bunny-images-token-key"]
  upload_key_ids  = ["bunny-stream-api-key", "bunny-storage-password"]
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

# M2's uploads (D80): api-user creates each Stream video and signs its TUS
# upload with the library key, and signs each image's S3 presigned PUT with the
# zone password. Only api-user may read these two, and no other service: with
# the library key a reader can also delete any video. Proven on dev by
# apps/dev-seed/behavioural/uploads.developer.ts (README, "Uploads").
resource "google_secret_manager_secret_iam_member" "upload_key_readers" {
  for_each = {
    for pair in setproduct(local.upload_key_ids, var.upload_key_readers) :
    "${pair[0]} ${pair[1]}" => { secret = pair[0], member = pair[1] }
  }

  project   = var.project_id
  secret_id = google_secret_manager_secret.app[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value.member
}

# Housekeeping (M2): the nightly Job lists the stories' library and deletes
# orphaned story videos (docs/media-runbook.md, "Replaced and orphaned
# videos"). The library key is the only Bunny secret it reads; the variable
# accepts nothing but this project's housekeeping service account, which the
# gcp root creates (apply that first).
resource "google_secret_manager_secret_iam_member" "stream_key_readers" {
  for_each = toset(var.stream_key_readers)

  project   = var.project_id
  secret_id = google_secret_manager_secret.app["bunny-stream-api-key"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}

# Housekeeping (M2 plan PR 10): the nightly Job deletes the images-zone folders of stories that
# are gone (erasure's queued pictures it retries, and abandoned drafts' pictures) with the zone
# password, through Bunny's Edge Storage API (docs/media-runbook.md). Only this project's
# housekeeping service account, as for the library key above.
resource "google_secret_manager_secret_iam_member" "storage_password_readers" {
  for_each = toset(var.storage_password_readers)

  project   = var.project_id
  secret_id = google_secret_manager_secret.app["bunny-storage-password"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}

# Media ready (M2 plan item 13; D78, D127): the library's read-only key, for
# api-user (it checks Bunny's webhook signatures) and the media worker (it reads
# a video's status, size, length and thumbnail at Bunny). Only those two
# accounts, which the gcp root creates (apply it first); never the full library
# key, which can delete every video.
resource "google_secret_manager_secret_iam_member" "readonly_key_readers" {
  for_each = toset(var.readonly_key_readers)

  project   = var.project_id
  secret_id = google_secret_manager_secret.app["bunny-stream-readonly-key"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}

# Audio picture videos (Joel, 2026-11-07: audio-picture-video.html decision 2 = K1). The result
# writer (apps/workflow on Cloud Run) makes each audio story's picture video at Bunny and signs
# the worker a one-hour upload pass for that one video with the library key, and signs 10-minute
# links to a story's picture with the images token key (for the worker, and for Bunny when it
# shows a video's own picture: video-bundle-rethink part A). Only this project's workflow account,
# and only these two keys: the full library key never leaves Google Cloud.
locals {
  result_writer_key_ids = ["bunny-stream-api-key", "bunny-images-token-key"]
}

resource "google_secret_manager_secret_iam_member" "result_writer_readers" {
  for_each = {
    for pair in setproduct(local.result_writer_key_ids, var.result_writer_readers) :
    "${pair[0]} ${pair[1]}" => { secret = pair[0], member = pair[1] }
  }

  project   = var.project_id
  secret_id = google_secret_manager_secret.app[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value.member
}

# The worker reads a picture video's sound from the library's own storage (Frankfurt, D89), not
# through Bunny's CDN, which would keep the old copy for up to 30 days (audio-picture-video.html
# section 1). The storage zone's read-only password reads files and can't change anything. Only
# once the zone is adopted (stream_storage_zone), and only the media-worker account reads it.
resource "google_secret_manager_secret" "stream_storage_readonly" {
  count = var.stream_storage_zone == null ? 0 : 1

  project   = var.project_id
  secret_id = "bunny-stream-storage-readonly-password"
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

resource "google_secret_manager_secret_version" "stream_storage_readonly" {
  count = var.stream_storage_zone == null ? 0 : 1

  secret                 = google_secret_manager_secret.stream_storage_readonly[0].id
  secret_data_wo         = bunnynet_storage_zone.stream[0].password_readonly
  secret_data_wo_version = parseint(substr(sha256(bunnynet_storage_zone.stream[0].password_readonly), 0, 12), 16)
  deletion_policy        = "ABANDON"
}

resource "google_secret_manager_secret_iam_member" "stream_storage_readers" {
  for_each = var.stream_storage_zone == null ? toset([]) : toset(var.stream_storage_readers)

  project   = var.project_id
  secret_id = google_secret_manager_secret.stream_storage_readonly[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}

