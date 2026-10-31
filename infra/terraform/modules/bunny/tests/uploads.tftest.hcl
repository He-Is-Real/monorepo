# M2's uploads (D80): api-user alone may read the two upload keys (the Stream
# library key and the images zone password), and no other bunny-* secret; the
# signing-key readers get no upload key. Mock providers: no Bunny or Google access.

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
  project_id  = "heisreal-dev"
  environment = "dev"
  signing_key_readers = [
    "serviceAccount:api-public-read@heisreal-dev.iam.gserviceaccount.com",
    "serviceAccount:api-user@heisreal-dev.iam.gserviceaccount.com",
  ]
  upload_key_readers = ["serviceAccount:api-user@heisreal-dev.iam.gserviceaccount.com"]
}

run "api_user_reads_exactly_the_two_upload_keys" {
  command = plan

  assert {
    condition = (
      length(google_secret_manager_secret_iam_member.upload_key_readers) == 2 &&
      toset([for g in google_secret_manager_secret_iam_member.upload_key_readers : g.secret_id]) == toset(["bunny-stream-api-key", "bunny-storage-password"]) &&
      alltrue([for g in google_secret_manager_secret_iam_member.upload_key_readers :
        g.member == "serviceAccount:api-user@heisreal-dev.iam.gserviceaccount.com" &&
        g.role == "roles/secretmanager.secretAccessor" &&
      g.project == "heisreal-dev"])
    )
    error_message = "api-user may read the Stream library key and the images zone password, as secretAccessor, and no other upload grant exists."
  }
  assert {
    condition = alltrue([for g in google_secret_manager_secret_iam_member.signing_key_readers :
    contains(["bunny-stream-token-key", "bunny-images-token-key"], g.secret_id)])
    error_message = "The signing-key readers (api-public-read among them) get no upload key."
  }
}

run "no_reader_no_grants" {
  command = plan
  variables {
    upload_key_readers = []
  }

  assert {
    condition     = length(google_secret_manager_secret_iam_member.upload_key_readers) == 0
    error_message = "Without a reader there are no upload key grants."
  }
}

run "other_services_refused" {
  command = plan
  variables {
    upload_key_readers = ["serviceAccount:api-public-read@heisreal-dev.iam.gserviceaccount.com"]
  }
  expect_failures = [var.upload_key_readers]
}

run "public_readers_refused" {
  command = plan
  variables {
    upload_key_readers = ["allUsers"]
  }
  expect_failures = [var.upload_key_readers]
}

run "people_and_groups_refused" {
  command = plan
  variables {
    upload_key_readers = ["group:developers@heisreal.today"]
  }
  expect_failures = [var.upload_key_readers]
}

run "another_projects_api_user_refused" {
  command = plan
  variables {
    upload_key_readers = ["serviceAccount:api-user@heisreal-prod.iam.gserviceaccount.com"]
  }
  expect_failures = [var.upload_key_readers]
}

# Housekeeping (M2): the nightly Job reads the Stream library key alone, and only this project's
# housekeeping service account may.
run "housekeeping_reads_only_the_stream_key" {
  command = plan
  variables {
    stream_key_readers = ["serviceAccount:housekeeping@heisreal-dev.iam.gserviceaccount.com"]
  }

  assert {
    condition = (
      length(google_secret_manager_secret_iam_member.stream_key_readers) == 1 &&
      google_secret_manager_secret_iam_member.stream_key_readers["serviceAccount:housekeeping@heisreal-dev.iam.gserviceaccount.com"].secret_id == "bunny-stream-api-key" &&
      google_secret_manager_secret_iam_member.stream_key_readers["serviceAccount:housekeeping@heisreal-dev.iam.gserviceaccount.com"].role == "roles/secretmanager.secretAccessor"
    )
    error_message = "housekeeping may read the Stream library key and no other bunny-* secret."
  }
}

run "stream_key_only_for_housekeeping" {
  command = plan
  variables {
    stream_key_readers = ["serviceAccount:api-public-read@heisreal-dev.iam.gserviceaccount.com"]
  }
  expect_failures = [var.stream_key_readers]
}

run "stream_key_never_public" {
  command = plan
  variables {
    stream_key_readers = ["allUsers"]
  }
  expect_failures = [var.stream_key_readers]
}
