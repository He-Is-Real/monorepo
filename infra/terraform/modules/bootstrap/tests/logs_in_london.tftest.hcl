# D101: the project's logs are stored in London for 30 days, and moving them changes nothing
# else: the _Default sink still takes every log except Google's audit logs (the _Required
# sink's). Mock providers: no Google access.

mock_provider "google" {
  mock_resource "google_service_account" {
    defaults = {
      email  = "mock-account@heisreal-dev.iam.gserviceaccount.com"
      name   = "projects/heisreal-dev/serviceAccounts/mock-account@heisreal-dev.iam.gserviceaccount.com"
      member = "serviceAccount:mock-account@heisreal-dev.iam.gserviceaccount.com"
    }
  }
  mock_data "google_iam_policy" {
    defaults = { policy_data = "{\"bindings\":[]}" }
  }
}
mock_provider "google" {
  alias = "billing"
}

variables {
  project_id             = "heisreal-dev"
  project_name           = "He Is Real dev"
  environment            = "dev"
  org_id                 = "463617123121"
  billing_account        = "000000-000000-000000"
  github_repository      = "He-Is-Real/monorepo"
  github_repository_id   = "1"
  budget_amount          = 15
  budget_alert_fractions = [0.2]
  developers             = ["user:dev@heisreal.today"]
}

# plan only: the PREVENT deletion policies would stop the test from cleaning up after an apply.
run "logs_in_london" {
  command = plan

  assert {
    condition = (
      google_logging_project_bucket_config.default.location == "europe-west2" &&
      google_logging_project_bucket_config.default.retention_days == 30
    )
    error_message = "The _Default sink's bucket is in London and keeps 30 days."
  }
  assert {
    condition     = google_logging_project_sink.default.destination == "logging.googleapis.com/projects/heisreal-dev/locations/europe-west2/buckets/default-europe-west2"
    error_message = "The _Default sink writes to the London bucket."
  }
  assert {
    condition = google_logging_project_sink.default.filter == join(" AND ", [
      "NOT LOG_ID(\"cloudaudit.googleapis.com/activity\")",
      "NOT LOG_ID(\"externalaudit.googleapis.com/activity\")",
      "NOT LOG_ID(\"cloudaudit.googleapis.com/system_event\")",
      "NOT LOG_ID(\"externalaudit.googleapis.com/system_event\")",
      "NOT LOG_ID(\"cloudaudit.googleapis.com/access_transparency\")",
      "NOT LOG_ID(\"externalaudit.googleapis.com/access_transparency\")",
    ])
    error_message = "The _Default sink keeps Google's filter: everything except the audit logs."
  }
}

# Everything bootstrap creates is in London: no other region is accepted (D119's interim guard).
run "region_only_london" {
  command = plan
  variables {
    region = "europe-west1"
  }
  expect_failures = [var.region]
}
