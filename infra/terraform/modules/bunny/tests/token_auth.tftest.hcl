# D52: token auth is on, the two token auth keys reach Secret Manager, and only the
# named readers may read them (no other bunny-* secret). Mock providers: no
# Bunny or Google access.

mock_provider "bunnynet" {
  mock_resource "bunnynet_storage_zone" {
    defaults = { id = 101 }
  }
  mock_resource "bunnynet_stream_library" {
    defaults = { id = 102, pullzone = 103 }
  }
  mock_data "bunnynet_pullzone" {
    defaults = {
      name           = "vz-test"
      cdn_domain     = "b-cdn.net"
      token_auth_key = "mock-stream-token-key"
    }
  }
}
mock_provider "google" {}

variables {
  project_id          = "heisreal-dev"
  environment         = "dev"
  signing_key_readers = ["serviceAccount:api-public-read@heisreal-dev.iam.gserviceaccount.com"]
}

run "token_auth_on_by_default" {
  command = plan

  assert {
    condition     = bunnynet_stream_library.media.view_token_authentication_required && bunnynet_stream_library.media.cdn_token_authentication_required
    error_message = "The Stream player and Stream CDN refuse unsigned links (D52)."
  }
  assert {
    condition     = bunnynet_pullzone.images.token_auth_enabled && !bunnynet_pullzone.images.token_auth_ip_validation
    error_message = "The images pull zone refuses unsigned links, without IP binding (D52)."
  }
}

# apply (mocked): the data source is read after the library, so its values are
# known only then.
run "signing_keys_in_secret_manager" {
  command = apply

  assert {
    condition = alltrue([for id in ["bunny-stream-token-key", "bunny-images-token-key"] :
    contains(keys(google_secret_manager_secret.app), id)])
    error_message = "Both token auth keys are copied into Secret Manager."
  }
  assert {
    condition     = output.stream_cdn_hostname == "vz-test.b-cdn.net"
    error_message = "The Stream CDN hostname comes from the library's pull zone."
  }
}

run "readers_get_only_the_signing_keys" {
  command = plan

  assert {
    condition = (
      length(google_secret_manager_secret_iam_member.signing_key_readers) == 2 &&
      toset([for g in google_secret_manager_secret_iam_member.signing_key_readers : g.secret_id]) == toset(["bunny-stream-token-key", "bunny-images-token-key"]) &&
      alltrue([for g in google_secret_manager_secret_iam_member.signing_key_readers :
        g.member == "serviceAccount:api-public-read@heisreal-dev.iam.gserviceaccount.com" &&
      g.role == "roles/secretmanager.secretAccessor"])
    )
    error_message = "api-public-read may read the two token auth keys and nothing else."
  }
}

run "no_readers_no_grants" {
  command = plan
  variables {
    signing_key_readers = []
  }

  assert {
    condition     = length(google_secret_manager_secret_iam_member.signing_key_readers) == 0
    error_message = "Without readers there are no grants."
  }
}

run "public_readers_refused" {
  command = plan
  variables {
    signing_key_readers = ["allUsers"]
  }
  expect_failures = [var.signing_key_readers]
}

run "people_and_groups_refused" {
  command = plan
  variables {
    signing_key_readers = ["group:developers@heisreal.today"]
  }
  expect_failures = [var.signing_key_readers]
}

run "other_projects_accounts_refused" {
  command = plan
  variables {
    signing_key_readers = ["serviceAccount:api-public-read@heisreal-prod.iam.gserviceaccount.com"]
  }
  expect_failures = [var.signing_key_readers]
}

run "token_auth_can_be_turned_off_per_delivery" {
  command = plan
  variables {
    token_auth = { stream_embed = true, stream_cdn = false, images = true }
  }

  assert {
    condition     = !bunnynet_stream_library.media.cdn_token_authentication_required && bunnynet_stream_library.media.view_token_authentication_required
    error_message = "The rollback switch turns off only Stream's CDN token auth."
  }
}

run "player_controls_are_touch_sized_without_script" {
  command = plan

  assert {
    condition = (
      strcontains(bunnynet_stream_library.media.player_custom_head, "min-width: 44px") &&
      strcontains(bunnynet_stream_library.media.player_custom_head, "min-height: 44px") &&
      !strcontains(lower(bunnynet_stream_library.media.player_custom_head), "<script") &&
      !strcontains(lower(bunnynet_stream_library.media.player_custom_head), "javascript:") &&
      !strcontains(lower(bunnynet_stream_library.media.player_custom_head), "@import") &&
      !strcontains(lower(bunnynet_stream_library.media.player_custom_head), "url(") &&
      strcontains(bunnynet_stream_library.media.player_custom_head, "background: #000")
    )
    error_message = "The player's custom head sizes controls to 44 px, makes the player opaque and is plain CSS: no script, imports or external URLs."
  }
}

# Site videos live in their own collection of the same library, so they share its player,
# encoding and token auth.
run "site_assets_collection_in_the_media_library" {
  command = plan

  assert {
    condition     = bunnynet_stream_collection.site_assets.name == "site-assets" && bunnynet_stream_collection.site_assets.library == 102
    error_message = "The site-assets collection is in the media library."
  }
}
