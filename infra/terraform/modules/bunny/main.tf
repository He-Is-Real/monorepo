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
}

# --- Storage + CDN: images ----------------------------------------------------
# Standard (HDD) tier: the cheapest, and the only tier that can be primaried in
# London (Edge/SSD zones are always primaried in Frankfurt). S3-compatible, so
# api-user can sign presigned uploads; type, tier and region are create-time
# only. One region: replication regions can never be removed again.
resource "bunnynet_storage_zone" "images" {
  name                = "${local.name}-images"
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
