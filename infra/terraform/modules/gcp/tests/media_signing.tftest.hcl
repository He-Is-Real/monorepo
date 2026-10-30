# D52: api-public-read gets the media-signing settings (identifiers and secret
# names, never values) only when api_public_read_media is set, and api-user (hearts,
# M2) only when api_user_media_signing is on too; api-admin never. Mock providers:
# no Google access.

mock_provider "google" {
  mock_resource "google_service_account" {
    defaults = {
      email  = "mock-account@heisreal-dev.iam.gserviceaccount.com"
      name   = "projects/heisreal-dev/serviceAccounts/mock-account@heisreal-dev.iam.gserviceaccount.com"
      member = "serviceAccount:mock-account@heisreal-dev.iam.gserviceaccount.com"
    }
  }
}
mock_provider "random" {}

variables {
  project_id               = "heisreal-dev"
  environment              = "dev"
  cluster_dns_domain       = "cluster.heisreal-dev.internal"
  ci_image_pusher_email    = "ci-image-pusher@heisreal-dev.iam.gserviceaccount.com"
  ci_snapshot_pusher_email = "ci-snapshot-pusher@heisreal-dev.iam.gserviceaccount.com"
  web_origins              = ["https://web-abc-nw.a.run.app"]
  clerk_issuer             = "https://example.clerk.accounts.dev"
  clerk_jwt_public_key     = "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n"
}

run "signing_off_by_default" {
  command = plan

  assert {
    condition = length([for e in google_cloud_run_v2_service.api_public_read.template[0].containers[0].env :
    e if startswith(e.name, "BUNNY_")]) == 0
    error_message = "Without api_public_read_media, no BUNNY_* variables (signing off)."
  }
}

run "signing_on_passes_identifiers_and_secret_names" {
  command = plan
  variables {
    api_public_read_media = {
      stream_library_id   = "786537"
      stream_cdn_hostname = "vz-da4dce15-a49.b-cdn.net"
      images_cdn_hostname = "heisreal-dev-images.b-cdn.net"
    }
  }

  assert {
    condition = {
      for e in google_cloud_run_v2_service.api_public_read.template[0].containers[0].env :
      e.name => e.value if startswith(e.name, "BUNNY_")
      } == {
      BUNNY_STREAM_LIBRARY_ID       = "786537"
      BUNNY_STREAM_CDN_HOST         = "vz-da4dce15-a49.b-cdn.net"
      BUNNY_IMAGES_CDN_HOST         = "heisreal-dev-images.b-cdn.net"
      BUNNY_STREAM_TOKEN_KEY_SECRET = "bunny-stream-token-key"
      BUNNY_IMAGES_TOKEN_KEY_SECRET = "bunny-images-token-key"
    }
    error_message = "The five BUNNY_* variables: identifiers and bunny-* secret names."
  }
}

run "malformed_settings_refused" {
  command = plan
  variables {
    api_public_read_media = {
      stream_library_id       = "786537"
      stream_cdn_hostname     = "https://vz-x.b-cdn.net/"
      images_cdn_hostname     = "heisreal-dev-images.b-cdn.net"
      images_token_key_secret = "surreal-root-password"
    }
  }
  expect_failures = [var.api_public_read_media]
}

run "api_user_signs_only_when_asked" {
  command = plan
  variables {
    api_public_read_media = {
      stream_library_id   = "786537"
      stream_cdn_hostname = "vz-da4dce15-a49.b-cdn.net"
      images_cdn_hostname = "heisreal-dev-images.b-cdn.net"
    }
  }

  assert {
    condition = length([for e in google_cloud_run_v2_service.signed_in_api["api-user"].template[0].containers[0].env :
    e if startswith(e.name, "BUNNY_")]) == 0
    error_message = "api-user gets no BUNNY_* variables unless api_user_media_signing is on."
  }
}

run "api_user_signs_like_api_public_read" {
  command = plan
  variables {
    api_public_read_media = {
      stream_library_id   = "786537"
      stream_cdn_hostname = "vz-da4dce15-a49.b-cdn.net"
      images_cdn_hostname = "heisreal-dev-images.b-cdn.net"
    }
    api_user_media_signing = true
  }

  assert {
    condition = {
      for e in google_cloud_run_v2_service.signed_in_api["api-user"].template[0].containers[0].env :
      e.name => e.value if startswith(e.name, "BUNNY_")
      } == {
      for e in google_cloud_run_v2_service.api_public_read.template[0].containers[0].env :
      e.name => e.value if startswith(e.name, "BUNNY_")
    }
    error_message = "api-user gets the same five BUNNY_* variables as api-public-read."
  }
  assert {
    condition = length([for e in google_cloud_run_v2_service.signed_in_api["api-admin"].template[0].containers[0].env :
    e if startswith(e.name, "BUNNY_")]) == 0
    error_message = "api-admin never signs media links."
  }
}

run "api_user_signing_needs_the_settings" {
  command = plan
  variables {
    api_user_media_signing = true
  }
  expect_failures = [var.api_user_media_signing]
}

# Site videos (the founder's on About and Next Steps): api-public-read gets each GUID as
# SITE_VIDEO_<KEY>, only for keys it knows and only with signing on.
run "site_videos_reach_api_public_read_only" {
  command = plan
  variables {
    api_public_read_media = {
      stream_library_id   = "786537"
      stream_cdn_hostname = "vz-da4dce15-a49.b-cdn.net"
      images_cdn_hostname = "heisreal-dev-images.b-cdn.net"
    }
    api_user_media_signing = true
    site_videos = {
      founder-intro = "0b6f1c3e-2d4a-4c5b-8e9f-1a2b3c4d5e6f"
      next-steps    = "7c2e9a14-5b3d-4f6e-a8c1-2d3e4f5a6b7c"
    }
  }

  assert {
    condition = {
      for e in google_cloud_run_v2_service.api_public_read.template[0].containers[0].env :
      e.name => e.value if startswith(e.name, "SITE_VIDEO_")
      } == {
      SITE_VIDEO_FOUNDER_INTRO = "0b6f1c3e-2d4a-4c5b-8e9f-1a2b3c4d5e6f"
      SITE_VIDEO_NEXT_STEPS    = "7c2e9a14-5b3d-4f6e-a8c1-2d3e4f5a6b7c"
    }
    error_message = "api-public-read gets SITE_VIDEO_FOUNDER_INTRO and SITE_VIDEO_NEXT_STEPS."
  }
  assert {
    condition = length([for e in google_cloud_run_v2_service.signed_in_api["api-user"].template[0].containers[0].env :
    e if startswith(e.name, "SITE_VIDEO_")]) == 0
    error_message = "Only api-public-read serves site videos."
  }
}

run "site_videos_unknown_key_refused" {
  command = plan
  variables {
    api_public_read_media = {
      stream_library_id   = "786537"
      stream_cdn_hostname = "vz-da4dce15-a49.b-cdn.net"
      images_cdn_hostname = "heisreal-dev-images.b-cdn.net"
    }
    site_videos = { contact = "0b6f1c3e-2d4a-4c5b-8e9f-1a2b3c4d5e6f" }
  }
  expect_failures = [var.site_videos]
}

run "site_videos_bad_guid_refused" {
  command = plan
  variables {
    api_public_read_media = {
      stream_library_id   = "786537"
      stream_cdn_hostname = "vz-da4dce15-a49.b-cdn.net"
      images_cdn_hostname = "heisreal-dev-images.b-cdn.net"
    }
    site_videos = { next-steps = "not-a-guid" }
  }
  expect_failures = [var.site_videos]
}

run "site_videos_need_signing" {
  command = plan
  variables {
    site_videos = { founder-intro = "0b6f1c3e-2d4a-4c5b-8e9f-1a2b3c4d5e6f" }
  }
  expect_failures = [var.site_videos]
}
