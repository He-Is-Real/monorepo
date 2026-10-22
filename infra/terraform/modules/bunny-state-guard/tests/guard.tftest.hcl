# The bunny root refuses to plan unless public_grants is empty (live/dev/bunny/main.tf).

variables {
  policies = {
    bucket = [
      { role = "roles/storage.objectAdmin", members = ["serviceAccount:tf-bunny@heisreal-dev.iam.gserviceaccount.com"], condition = { title = "only-bunny-state", expression = "true" } },
      { role = "roles/storage.bucketViewer", members = ["serviceAccount:tf-planner@heisreal-dev.iam.gserviceaccount.com"] },
    ]
    project = [
      { role = "roles/owner", members = ["user:joel@heisreal.today"] },
      { role = "roles/viewer", members = ["serviceAccount:tf-planner@heisreal-dev.iam.gserviceaccount.com", "serviceAccount:service-236063168938@gcp-sa-cloudbuild.iam.gserviceaccount.com"] },
    ]
    keyring = []
    "key/tofu-state" = [
      { role = "roles/cloudkms.cryptoKeyEncrypterDecrypter", members = ["user:joel@heisreal.today", "serviceAccount:tf-deployer@heisreal-dev.iam.gserviceaccount.com"] },
    ]
    "key/tofu-bunny" = [
      { role = "roles/cloudkms.cryptoKeyEncrypterDecrypter", members = ["user:joel@heisreal.today", "serviceAccount:tf-bunny@heisreal-dev.iam.gserviceaccount.com"] },
    ]
    "secret/bunny-account-api-key" = []
    "secret/bunny-stream-api-key" = [
      { role = "roles/secretmanager.secretAccessor", members = ["group:developers@heisreal.today"] },
    ]
  }
}

run "clean_policies_pass" {
  command = plan
  assert {
    condition     = output.public_grants == []
    error_message = "Developers and service accounts are never public."
  }
}

run "all_users_on_bucket_fails" {
  command = plan
  variables {
    policies = {
      bucket = [
        { role = "roles/storage.bucketViewer", members = ["serviceAccount:tf-planner@heisreal-dev.iam.gserviceaccount.com"] },
        { role = "roles/storage.objectViewer", members = ["allUsers"] },
      ]
    }
  }
  assert {
    condition     = output.public_grants == ["bucket: allUsers (roles/storage.objectViewer)"]
    error_message = "allUsers on the state bucket must be reported by name, member and role."
  }
}

run "all_authenticated_on_secret_fails" {
  command = plan
  variables {
    policies = {
      "secret/bunny-account-api-key" = [
        {
          role      = "roles/secretmanager.secretAccessor"
          members   = ["user:joel@heisreal.today", "allAuthenticatedUsers"]
          condition = { title = "looks-narrow", expression = "request.time < timestamp('2000-01-01T00:00:00Z')" }
        },
      ]
    }
  }
  assert {
    condition     = length(output.public_grants) == 1
    error_message = "allAuthenticatedUsers counts even with a condition."
  }
}

run "public_on_keyring_fails" {
  command = plan
  variables {
    policies = {
      keyring = [{ role = "roles/cloudkms.viewer", members = ["allUsers"] }]
      bucket  = []
    }
  }
  assert {
    condition     = length(output.public_grants) == 1
    error_message = "A public keyring grant must be reported."
  }
}

run "empty_policy_is_fine" {
  command = plan
  variables {
    policies = { bucket = [] }
  }
  assert {
    condition     = output.public_grants == []
    error_message = "A policy with no bindings has no public grants."
  }
}
