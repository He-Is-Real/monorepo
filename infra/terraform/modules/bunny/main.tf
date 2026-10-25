# Bunny.net media for one environment (stack decision: Stream for video and
# audio, Storage + CDN for images). No custom hostnames (D7).
#
# STATE HOLDS SECRETS here, and only here (approved exception, see AGENTS.md):
# the provider stores the library keys (api_key, api_key_readonly), the zone
# passwords (password, password_readonly) and the pull zones' token_auth_key
# (the images zone, and the Stream zone through data.bunnynet_pullzone.stream)
# as computed attributes, with no write-only alternative. The state prefix is
# readable by developers only (modules/bootstrap/state.tf).
#
# Uploads never pass through our services (decided 2026-10-21, implemented in
# M2): api-user creates the Stream video and signs a TUS upload, and signs S3
# presigned PUTs for images. The keys it needs are copied into Secret Manager
# (secrets.tf).

locals {
  name = "heisreal-${var.environment}"
}

# --- Stream: video and audio testimonies -------------------------------------
# Every paid or AI feature is set explicitly, so a dashboard change shows up as
# drift in the next plan. Not in the provider (v0.19): automatic chapters and
# moments; both are off by default and, per Bunny, enabling either turns on
# transcribing, which this resource would then show as drift.
resource "bunnynet_stream_library" "media" {
  name = "${local.name}-media"

  # Encoding: free tier, x264 only, a small resolution ladder, no extra copies.
  encoding_tier                     = "Free"
  jit_encoding                      = false # premium only
  output_codecs                     = ["x264"]
  resolutions                       = var.stream_resolutions
  mp4_fallback_enabled              = false # would store an MP4 per resolution
  original_files_keep               = false # don't keep the upload after encoding
  multi_audio_track_support_enabled = false
  early_play_enabled                = false # also exposes originals via the CDN

  # No AI features: we transcribe ourselves later and upload captions.
  transcribing_enabled                   = false
  transcribing_smart_title_enabled       = false
  transcribing_smart_description_enabled = false
  content_tagging_enabled                = false

  # Security: no domain yet (D7), so no referrer lists. The embed player is how
  # videos are watched, so direct play URLs are off and requests without a
  # referrer are refused. Token auth (D52): the player needs a signed embed URL
  # (view token) and every CDN file, HLS and thumbnails included, a signed URL
  # (CDN token). The player signs its own HLS requests. Both use the Stream
  # pull zone's key (secrets.tf), which api-public-read signs with.
  direct_play_enabled                = false
  direct_url_file_access_blocked     = true
  view_token_authentication_required = var.token_auth.stream_embed
  cdn_token_authentication_required  = var.token_auth.stream_cdn
  drm_mediacage_basic_enabled        = false

  # Player: Bunny's defaults without AirPlay (no Apple-specific technology).
  player_language = "en"
  player_controls = [
    "play-large", "play", "progress", "current-time", "duration", "mute",
    "volume", "captions", "settings", "pip", "fullscreen",
  ]
  player_watchtime_heatmap_enabled = false
  vast_tag_url                     = "" # no adverts
  # 44 px touch targets (AGENTS.md) and an opaque background: CSS in the
  # player's <head> (Bunny's "Custom HTML" setting). CSS only, no script.
  player_custom_head = trimspace(file("${path.module}/player-head.html"))
}

# The storage zone Bunny made for the library, where its videos live. Bunny sets
# Stream storage's main region (Frankfurt, EU) and it can't be chosen: neither
# Bunny's create-library API nor the provider can set it. D89 (Joel,
# 2026-10-25): Frankfurt is accepted since London isn't possible; no
# replication, so no copy in London or anywhere else. We declare it anyway
# so where the videos live is written down and any change shows up as drift.
# Adopted by the root's import block (it exists only once the library does).
# Replication regions can never be removed again and cost extra per region.
resource "bunnynet_storage_zone" "stream" {
  count = var.stream_storage_zone == null ? 0 : 1

  name                = var.stream_storage_zone.name
  region              = "DE"
  zone_tier           = "Standard"
  type                = "Standard"
  replication_regions = []

  lifecycle {
    # Destroying it deletes every video in the library.
    prevent_destroy = true
    precondition {
      condition     = tostring(var.stream_storage_zone.id) == tostring(bunnynet_stream_library.media.storage_zone)
      error_message = "stream_storage_zone must be the library's own storage zone (bunnynet_stream_library.media.storage_zone)."
    }
  }
}

# --- Storage + CDN: images ----------------------------------------------------
# Standard (HDD) tier: the cheapest, and the only tier that can be primaried in
# London (Edge/SSD zones are always primaried in Frankfurt). S3-compatible, so
# api-user can sign presigned uploads; type, tier and region are create-time
# only. One region: replication regions can never be removed again.
resource "bunnynet_storage_zone" "images" {
  # Not "-images": Bunny still reserves that name from the deleted first account
  # (2026-10-25). The pull zone below keeps "-images", so the CDN host is unchanged.
  name                = "${local.name}-image-store"
  region              = var.storage_region
  zone_tier           = "Standard"
  type                = "S3"
  replication_regions = []
  rewrite_404_to_200  = false
}

resource "bunnynet_pullzone" "images" {
  name = "${local.name}-images" # served at https://<name>.b-cdn.net

  origin {
    type        = "StorageZone"
    storagezone = bunnynet_storage_zone.images.id
  }

  routing {
    tier  = "Standard"
    zones = var.cdn_routing_zones
  }

  # Nothing that costs extra.
  optimizer_enabled      = false
  originshield_enabled   = false
  permacache_storagezone = 0
  websockets_enabled     = false
  log_forward_enabled    = false
  log_storage_enabled    = false

  # Logs (Bunny's dashboard statistics) without visitor IPs.
  log_enabled          = true
  log_anonymized       = true
  log_anonymized_style = "Drop"

  block_root_path     = true # no directory-style requests
  block_post_requests = true
  block_no_referer    = false # no domain yet (D7): referrer rules come with it
  tls_support         = []    # TLS 1.2+ only

  # D52: every image needs a signed, expiring URL (api-public-read signs those of
  # published stories), so unpublished images aren't reachable. No IP binding:
  # visitors' addresses change (mobile networks).
  token_auth_enabled       = var.token_auth.images
  token_auth_ip_validation = false
}

# The pull zone Bunny made for the Stream library (embed and HLS delivery,
# thumbnails). Read for its hostname and token auth key only; the library
# resource manages its settings.
data "bunnynet_pullzone" "stream" {
  id = bunnynet_stream_library.media.pullzone
}
