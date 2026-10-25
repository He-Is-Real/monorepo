# D102 and D104: the organisation allows UK locations only, and new projects' log buckets are
# created in London, which that policy must allow. Mock provider: no Google access.

mock_provider "google" {}

variables {
  org_id               = "463617123121"
  allowed_locations    = ["in:gb-locations"]
  log_storage_location = "europe-west2"
}

run "uk_only" {
  command = plan

  assert {
    condition = (
      google_logging_organization_settings.this.storage_location == "europe-west2" &&
      google_logging_organization_settings.this.disable_default_sink == false &&
      google_logging_organization_settings.this.kms_key_name == ""
    )
    error_message = "New projects' log buckets are created in London, with _Default on and no CMEK."
  }
  assert {
    condition = (
      google_org_policy_policy.resource_locations.name == "organizations/463617123121/policies/gcp.resourceLocations" &&
      google_org_policy_policy.resource_locations.spec[0].rules[0].values[0].allowed_values == tolist(["in:gb-locations"])
    )
    error_message = "The organisation allows UK locations only."
  }
}

run "log_location_must_be_allowed" {
  command = plan
  variables {
    log_storage_location = "europe-west1"
  }
  expect_failures = [google_org_policy_policy.resource_locations]
}

run "empty_list_refused" {
  command = plan
  variables {
    allowed_locations = []
  }
  expect_failures = [var.allowed_locations]
}
