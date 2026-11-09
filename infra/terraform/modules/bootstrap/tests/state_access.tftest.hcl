# Which state each CI identity may touch in the state bucket (state.tf). tf-deployer and the
# planners never reach the bunny root's state (it holds Bunny's keys) or the org root's (only an
# organisation admin applies it, locally); tf-bunny reaches only its own. Mock providers: no
# Google access.

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

run "ci_state_access" {
  command = plan

  # tf-deployer (objectAdmin) and the planners (objectViewer): everything but bunny and org.
  assert {
    condition = alltrue([
      for b in data.google_iam_policy.tfstate.binding :
      one(b.condition).expression == join(" && ", [
        "!resource.name.startsWith('projects/_/buckets/heisreal-dev-tfstate/objects/dev/bunny/')",
        "!resource.name.startsWith('projects/_/buckets/heisreal-dev-tfstate/objects/org/')",
      ])
      if length(b.condition) > 0 && one(b.condition).title == "not-private-state"
    ])
    error_message = "tf-deployer and the planners get no object in dev/bunny/ or org/."
  }
  assert {
    condition = length([
      for b in data.google_iam_policy.tfstate.binding : b
      if length(b.condition) > 0 && one(b.condition).title == "not-private-state"
    ]) == 2
    error_message = "Both CI object bindings (deployer, planners) carry the condition."
  }
  # tf-bunny: its own prefix (and bucket-level listing) only, never org/.
  assert {
    condition = alltrue([
      for b in data.google_iam_policy.tfstate.binding :
      one(b.condition).expression == join(" || ", [
        "resource.type == 'storage.googleapis.com/Bucket'",
        "resource.name.startsWith('projects/_/buckets/heisreal-dev-tfstate/objects/dev/bunny/')",
      ])
      if length(b.condition) > 0 && one(b.condition).title == "only-bunny-state"
    ])
    error_message = "tf-bunny reaches only dev/bunny/ objects."
  }
  # No other object binding: only the bucket-metadata one has no condition.
  assert {
    condition = alltrue([
      for b in data.google_iam_policy.tfstate.binding :
      b.role == "roles/storage.bucketViewer" if length(b.condition) == 0
    ])
    error_message = "Every object role on the state bucket is conditioned."
  }
}
