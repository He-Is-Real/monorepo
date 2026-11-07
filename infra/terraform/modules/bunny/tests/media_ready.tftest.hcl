# Media ready (M2 plan item 13; D78, D127): the library's read-only key goes to Secret Manager, and
# only api-user (Bunny's webhook signatures) and media-worker (a video's facts) may read it. The
# worker can never read Bunny's full library key, which can delete every video, nor the images
# zone's password; and Bunny posts its events to api-user's webhook. Mock providers.

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
  project_id         = "heisreal-dev"
  environment        = "dev"
  upload_key_readers = ["serviceAccount:api-user@heisreal-dev.iam.gserviceaccount.com"]
  stream_key_readers = ["serviceAccount:housekeeping@heisreal-dev.iam.gserviceaccount.com"]
  readonly_key_readers = [
    "serviceAccount:api-user@heisreal-dev.iam.gserviceaccount.com",
    "serviceAccount:media-worker@heisreal-dev.iam.gserviceaccount.com",
  ]
  stream_webhook_url = "https://api-user-abc-nw.a.run.app/v1/webhooks/bunny"
}

run "the_read_only_key_for_api_user_and_the_worker" {
  command = plan

  assert {
    condition = (
      contains(keys(google_secret_manager_secret.app), "bunny-stream-readonly-key") &&
      length(google_secret_manager_secret_iam_member.readonly_key_readers) == 2 &&
      alltrue([for g in google_secret_manager_secret_iam_member.readonly_key_readers :
        g.secret_id == "bunny-stream-readonly-key" && g.role == "roles/secretmanager.secretAccessor"
      ])
    )
    error_message = "api-user and media-worker may read the read-only library key, as secretAccessor."
  }
  assert {
    condition = alltrue(flatten([
      [for g in google_secret_manager_secret_iam_member.upload_key_readers : g.member != "serviceAccount:media-worker@heisreal-dev.iam.gserviceaccount.com"],
      [for g in google_secret_manager_secret_iam_member.stream_key_readers : g.member != "serviceAccount:media-worker@heisreal-dev.iam.gserviceaccount.com"],
      [for g in google_secret_manager_secret_iam_member.storage_password_readers : g.member != "serviceAccount:media-worker@heisreal-dev.iam.gserviceaccount.com"],
      [for g in google_secret_manager_secret_iam_member.signing_key_readers : g.member != "serviceAccount:media-worker@heisreal-dev.iam.gserviceaccount.com"],
    ]))
    error_message = "media-worker reads no other bunny-* secret (never the full library key)."
  }
  assert {
    condition     = bunnynet_stream_library.media.webhook_url == "https://api-user-abc-nw.a.run.app/v1/webhooks/bunny"
    error_message = "Bunny posts the library's events to api-user's webhook."
  }
}

run "the_worker_never_gets_the_full_key" {
  command = plan
  variables {
    stream_key_readers = ["serviceAccount:media-worker@heisreal-dev.iam.gserviceaccount.com"]
  }
  expect_failures = [var.stream_key_readers]
}

run "the_worker_never_gets_the_upload_keys" {
  command = plan
  variables {
    upload_key_readers = ["serviceAccount:media-worker@heisreal-dev.iam.gserviceaccount.com"]
  }
  expect_failures = [var.upload_key_readers]
}

run "no_one_else_reads_the_read_only_key" {
  command = plan
  variables {
    readonly_key_readers = ["serviceAccount:api-public-read@heisreal-dev.iam.gserviceaccount.com"]
  }
  expect_failures = [var.readonly_key_readers]
}

run "never_public" {
  command = plan
  variables {
    readonly_key_readers = ["allUsers"]
  }
  expect_failures = [var.readonly_key_readers]
}

run "never_a_person" {
  command = plan
  variables {
    readonly_key_readers = ["user:joel@heisreal.today"]
  }
  expect_failures = [var.readonly_key_readers]
}

run "webhook_only_to_the_route" {
  command = plan
  variables {
    stream_webhook_url = "http://api-user-abc-nw.a.run.app/v1/webhooks/bunny"
  }
  expect_failures = [var.stream_webhook_url]
}
