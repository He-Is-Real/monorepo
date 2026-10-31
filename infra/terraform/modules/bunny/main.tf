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
  encoding_tier        = "Free"
  jit_encoding         = false # premium only
  output_codecs        = ["x264"]
  resolutions          = var.stream_resolutions
  mp4_fallback_enabled = false # would store an MP4 per resolution
  # O2 B (Joel, 2026-10-31): keep each upload as it arrived, so "Download my data" can give the
  # person their own file back (a signed link to <video id>/original, api-user's export). Only
  # videos uploaded after this is applied have one. Costs storage (Frankfurt, D89).
  # Bunny serves them on the CDN only with the library's ExposeOriginals on (not
  # in this provider, 0.19.2). Keep it OFF: the player's folder-wide token would
  # then open <video id>/original for any viewer (docs/media-runbook.md, "Originals").
  original_files_keep               = true
  multi_audio_track_support_enabled = false
  early_play_enabled                = false # would serve unencoded originals as playback

  # No AI features: we transcribe ourselves later and upload captions.
  transcribing_enabled                   = false
  transcribing_smart_title_enabled       = false
  transcribing_smart_description_enabled = false
  content_tagging_enabled                = false

  # Security: no domain yet (D7), so no referrer lists. The embed player is how
  # videos are watched, so direct play URLs are off. Token auth (D52) is what
  # guards every file: the player needs a signed embed URL (view token) and
  # every CDN file, HLS, thumbnails and kept originals included, a signed,
  # expiring URL (CDN token). The player signs its own HLS requests. Both use the
  # Stream pull zone's key (secrets.tf), which api-public-read signs with.
  # Requests without a referrer are allowed (Joel, 2026-10-31): "Download my
  # data" links (the original, a thumbnail) are opened by pasting them into the
  # address bar, which sends none, and Bunny refused those with 403. Blocking
  # them only added a hotlink check on top of the token: an unsigned or expired
  # link is still refused.
  direct_play_enabled                = false
  direct_url_file_access_blocked     = false
  view_token_authentication_required = var.token_auth.stream_embed
  cdn_token_authentication_required  = var.token_auth.stream_cdn
  drm_mediacage_basic_enabled        = false

  # Player, matched to the site theme (apps/web/src/app/global.css). Every visual setting is
  # explicit, so a dashboard change shows up as drift. The player is dark in both site themes,
  # like the design's player: it's a frame from Bunny's domain, and Bunny has no theme option
  # (no URL parameter), so it can't follow the site's light/dark switch. What each setting
  # does: docs/media-runbook.md, "The Stream player".
  player_version       = 2         # Bunny's current player (media-chrome), which player-head.html targets
  player_primary_color = "#4e9ba0" # brand teal: progress bar, volume, large play button
  # The site's font (DM Sans) isn't one of Bunny's eight; Inter is the closest. Bunny serves it
  # from its own font CDN (fonts.bunny.net), which the player loads anyway.
  player_font_family = "inter"
  # Captions sit on the video, so they don't change with the site theme: white on opaque black
  # is the most readable on any picture (21:1). 20 px is Bunny's default.
  player_captions_font_color       = "#ffffff"
  player_captions_background_color = "#000000"
  player_captions_font_size        = 20
  player_language                  = "en"
  # Bunny's defaults without AirPlay (no Apple-specific technology). A set: Bunny draws them in
  # its own fixed order. No Chromecast, no rewind/fast-forward (the progress bar seeks).
  player_controls = [
    "play-large", "play", "progress", "current-time", "duration", "mute",
    "volume", "captions", "settings", "pip", "fullscreen",
  ]
  player_watchtime_heatmap_enabled = false
  # No watermark: none is uploaded (only Bunny's API can), and these only place one.
  watermark_position_left = 0
  watermark_position_top  = 0
  watermark_width         = 0
  watermark_height        = 0
  vast_tag_url            = "" # no adverts
  # 44 px touch targets (AGENTS.md), an opaque background, the site's focus ring and the large
  # play button's icon colour: CSS in the player's <head> (Bunny's "Custom HTML" setting).
  # CSS only: no script, imports or external URLs.
  player_custom_head = trimspace(file("${path.module}/player-head.html"))
}

# Site assets: videos that are part of the site itself (the founder's introduction on About),
# kept apart from story videos in their own collection. Story videos never go in it. Uploaded with
# tools/scripts/site-asset-upload.mjs; api-public-read signs them by a fixed list of keys
# (SITE_VIDEO_* in the gcp root). Same library, so the same player, encoding and token auth.
# Non-video site assets (images and the like) go under the `site-assets/` path in the images
# storage zone below: a naming rule only (Edge Storage folders are implicit), behind the same
# signed pull zone. prevent_destroy, like the Stream storage zone: destroying the collection
# deletes every video in it.
resource "bunnynet_stream_collection" "site_assets" {
  library = bunnynet_stream_library.media.id
  name    = "site-assets"

  lifecycle {
    prevent_destroy = true
  }
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
