# Where media lives is declared, never left to Bunny's defaults: images in
# London, Stream's videos in Frankfurt (Bunny's choice, written down), neither
# replicated. Mock providers: no Bunny or Google access.

mock_provider "bunnynet" {
  mock_resource "bunnynet_storage_zone" {
    defaults = { id = 101 }
  }
  mock_resource "bunnynet_stream_library" {
    defaults = { id = 102, pullzone = 103, storage_zone = 104 }
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
  signing_key_readers = []
  stream_storage_zone = { id = 104, name = "vz-test" }
}

# plan only: prevent_destroy would stop the test from cleaning up after an apply.
run "media_locations_are_declared" {
  command = plan

  assert {
    condition = (
      bunnynet_storage_zone.images.region == "UK" &&
      length(bunnynet_storage_zone.images.replication_regions) == 0
    )
    error_message = "Images are stored in London only."
  }
  assert {
    condition = (
      bunnynet_storage_zone.stream[0].name == "vz-test" &&
      bunnynet_storage_zone.stream[0].region == "DE" &&
      bunnynet_storage_zone.stream[0].zone_tier == "Standard" &&
      length(bunnynet_storage_zone.stream[0].replication_regions) == 0
    )
    error_message = "Stream's videos are declared in Frankfurt only, on the Standard tier."
  }
}

run "stream_zone_must_be_the_librarys" {
  command = plan
  variables {
    stream_storage_zone = { id = 999, name = "vz-other" }
  }
  expect_failures = [bunnynet_storage_zone.stream]
}
