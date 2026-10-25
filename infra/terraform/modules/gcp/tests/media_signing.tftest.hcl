# D52: api-public-read gets the media-signing settings (identifiers and secret
# names, never values) only when api_public_read_media is set. Mock providers:
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
