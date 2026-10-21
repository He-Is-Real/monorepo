# The bunny root refuses to plan unless object_readers is empty (live/dev/bunny/main.tf).

variables {
  project_id    = "heisreal-dev"
  state_readers = ["user:joel@heisreal.today"]
  service_agents = [
    "serviceAccount:service-236063168938@gcp-sa-cloudbuild.iam.gserviceaccount.com",
    "serviceAccount:service-236063168938@gcf-admin-robot.iam.gserviceaccount.com",
    "serviceAccount:service-236063168938@compute-system.iam.gserviceaccount.com",
    "serviceAccount:service-236063168938@containerregistry.iam.gserviceaccount.com",
    "serviceAccount:service-236063168938@serverless-robot-prod.iam.gserviceaccount.com",
  ]
  role_permissions = {
    "roles/storage.objectViewer"                = ["storage.objects.get", "storage.objects.list"]
    "roles/viewer"                              = ["storage.buckets.list"]
    "roles/cloudbuild.builds.builder"           = ["cloudbuild.builds.create", "storage.objects.get"]
    "roles/container.defaultNodeServiceAccount" = ["logging.logEntries.create"]
  }
  bindings = [
    { role = "roles/storage.admin", members = ["user:joel@heisreal.today"] },
    { role = "roles/viewer", members = ["serviceAccount:tf-planner@heisreal-dev.iam.gserviceaccount.com"] },
    { role = "roles/container.defaultNodeServiceAccount", members = ["serviceAccount:gke-nodes@heisreal-dev.iam.gserviceaccount.com"] },
    { role = "roles/cloudbuild.serviceAgent", members = ["serviceAccount:service-236063168938@gcp-sa-cloudbuild.iam.gserviceaccount.com"] },
    { role = "roles/cloudfunctions.standardServiceAgent", members = ["serviceAccount:service-236063168938@gcf-admin-robot.iam.gserviceaccount.com"] },
    { role = "roles/compute.serviceAgent", members = ["serviceAccount:service-236063168938@compute-system.iam.gserviceaccount.com"] },
    { role = "roles/containerregistry.ServiceAgent", members = ["serviceAccount:service-236063168938@containerregistry.iam.gserviceaccount.com"] },
    { role = "roles/run.serviceAgent", members = ["serviceAccount:service-236063168938@serverless-robot-prod.iam.gserviceaccount.com"] },
  ]
}

run "developers_and_each_listed_agent_pass" {
  command = plan
  assert {
    condition     = length(output.object_readers) == 0
    error_message = "Developers, the five verified agents and roles without storage.objects.get must pass."
  }
  assert {
    condition     = toset(output.roles_to_check) == toset(["roles/container.defaultNodeServiceAccount", "roles/viewer"])
    error_message = "Only principals outside the allowed set get their roles expanded."
  }
}

run "user_sa_named_like_an_agent_fails" {
  command = plan
  variables {
    bindings = [{ role = "roles/storage.objectViewer", members = ["serviceAccount:service-123@heisreal-dev.iam.gserviceaccount.com"] }]
  }
  assert {
    condition     = output.object_readers == ["serviceAccount:service-123@heisreal-dev.iam.gserviceaccount.com (roles/storage.objectViewer)"]
    error_message = "A user-managed account whose ID looks like an agent's is checked like any other."
  }
}

run "new_unlisted_agent_fails" {
  command = plan
  variables {
    bindings = [{ role = "roles/storage.objectViewer", members = ["serviceAccount:service-236063168938@gcp-sa-newthing.iam.gserviceaccount.com"] }]
  }
  assert {
    condition     = length(output.object_readers) == 1
    error_message = "A service agent that isn't on the list fails until a developer reviews and adds it."
  }
}

run "legacy_cloudbuild_account_fails" {
  command = plan
  variables {
    bindings = [{ role = "roles/cloudbuild.builds.builder", members = ["serviceAccount:236063168938@cloudbuild.gserviceaccount.com"] }]
  }
  assert {
    condition     = length(output.object_readers) == 1
    error_message = "The legacy Cloud Build account acts for whoever runs a build: never exempt."
  }
}

run "unexpanded_role_fails_closed" {
  command = plan
  variables {
    bindings = [{ role = "roles/someNewRole", members = ["serviceAccount:tf-planner@heisreal-dev.iam.gserviceaccount.com"] }]
  }
  assert {
    condition     = length(output.object_readers) == 1
    error_message = "A role whose permissions weren't looked up counts as a reader."
  }
}

run "project_domain_agent_cannot_be_listed" {
  command = plan
  variables {
    service_agents = ["serviceAccount:service-123@heisreal-dev.iam.gserviceaccount.com"]
  }
  expect_failures = [var.service_agents]
}
