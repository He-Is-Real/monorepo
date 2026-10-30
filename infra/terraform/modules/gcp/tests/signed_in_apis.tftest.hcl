# api-user and api-admin (M2 prerequisite): each has its own runtime service account that may read
# only its own database password, signs in as its own service record (D13 B), and gets the Clerk
# settings and web's origins (CLERK_AUTHORIZED_PARTIES, CORS) it needs to start. Mock providers.

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
  web_origins              = ["https://web-abc-nw.a.run.app", "https://web-123.europe-west2.run.app"]
  clerk_issuer             = "https://example.clerk.accounts.dev"
  clerk_jwt_public_key     = <<-EOT
    -----BEGIN PUBLIC KEY-----
    MIIBIjAN
    4QIDAQAB
    -----END PUBLIC KEY-----
  EOT
}

run "each_service_has_its_own_identity_and_login" {
  command = plan

  assert {
    condition = (
      google_service_account.signed_in_api["api-user"].account_id == "api-user" &&
      google_service_account.signed_in_api["api-admin"].account_id == "api-admin"
    )
    error_message = "api-user and api-admin each run as their own service account."
  }

  assert {
    condition = (
      google_secret_manager_secret_iam_member.signed_in_api["api-user"].secret_id == "surreal-api-user-password" &&
      google_secret_manager_secret_iam_member.signed_in_api["api-admin"].secret_id == "surreal-api-admin-password" &&
      length(google_secret_manager_secret_iam_member.signed_in_api) == 2
    )
    error_message = "Each service may read only its own database password."
  }

  assert {
    condition = alltrue([for svc, user in { "api-user" = "api_user", "api-admin" = "api_admin" } :
      one([for e in google_cloud_run_v2_service.signed_in_api[svc].template[0].containers[0].env :
      e.value if e.name == "SURREAL_USER"]) == user
    ])
    error_message = "api-user signs in as api_user, api-admin as api_admin."
  }
}

run "clerk_and_cors_settings" {
  command = plan

  assert {
    condition = alltrue([for svc in ["api-user", "api-admin"] :
      { for e in google_cloud_run_v2_service.signed_in_api[svc].template[0].containers[0].env :
        e.name => e.value if contains(["CLERK_ISSUER", "CLERK_JWT_PUBLIC_KEY", "CLERK_AUTHORIZED_PARTIES", "CORS_ALLOWED_ORIGINS"], e.name)
        } == {
        CLERK_ISSUER             = "https://example.clerk.accounts.dev"
        CLERK_JWT_PUBLIC_KEY     = "-----BEGIN PUBLIC KEY-----\\nMIIBIjAN\\n4QIDAQAB\\n-----END PUBLIC KEY-----"
        CLERK_AUTHORIZED_PARTIES = "https://web-abc-nw.a.run.app,https://web-123.europe-west2.run.app"
        CORS_ALLOWED_ORIGINS     = "https://web-abc-nw.a.run.app,https://web-123.europe-west2.run.app"
      }
    ])
    error_message = "Both services get the issuer, the key on one line and web's origins as azp and CORS origins."
  }
}

run "private_by_default" {
  command = plan

  assert {
    condition = (
      !google_cloud_run_v2_service.signed_in_api["api-user"].invoker_iam_disabled &&
      !google_cloud_run_v2_service.signed_in_api["api-admin"].invoker_iam_disabled
    )
    error_message = "The invoker check stays on unless signed_in_apis_public is set."
  }
}

run "needs_web_origins" {
  command = plan
  variables {
    web_origins = []
  }
  expect_failures = [
    google_cloud_run_v2_service.signed_in_api["api-user"],
    google_cloud_run_v2_service.signed_in_api["api-admin"],
  ]
}

run "refuses_a_private_key" {
  command = plan
  variables {
    clerk_jwt_public_key = "-----BEGIN PUBLIC KEY-----\nPRIVATE\n-----END PUBLIC KEY-----"
  }
  expect_failures = [var.clerk_jwt_public_key]
}

# Uploads (M2 plan PR 7): api-user alone gets the Stream library and the library key's secret
# name (never its value), merged with media signing's variables; api-admin gets neither.
run "uploads_only_on_api_user" {
  command = plan

  variables {
    api_public_read_media = {
      stream_library_id   = "789855"
      stream_cdn_hostname = "vz-abc.b-cdn.net"
      images_cdn_hostname = "images.b-cdn.net"
    }
    api_user_media_signing = true
    api_user_uploads       = true
  }

  assert {
    condition = (
      { for e in google_cloud_run_v2_service.signed_in_api["api-user"].template[0].containers[0].env :
        e.name => e.value if contains(["BUNNY_STREAM_LIBRARY_ID", "BUNNY_STREAM_API_KEY_SECRET"], e.name)
        } == {
        BUNNY_STREAM_LIBRARY_ID     = "789855"
        BUNNY_STREAM_API_KEY_SECRET = "bunny-stream-api-key"
      } &&
      length([for e in google_cloud_run_v2_service.signed_in_api["api-user"].template[0].containers[0].env :
      e if e.name == "BUNNY_STREAM_LIBRARY_ID"]) == 1 &&
      length([for e in google_cloud_run_v2_service.signed_in_api["api-admin"].template[0].containers[0].env :
      e if startswith(e.name, "BUNNY_")]) == 0
    )
    error_message = "Only api-user gets the upload settings, once each, beside media signing's."
  }
}

run "uploads_need_the_library" {
  command = plan

  variables {
    api_user_uploads = true
  }

  expect_failures = [var.api_user_uploads]
}
