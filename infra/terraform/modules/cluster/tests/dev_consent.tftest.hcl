# D48: relaxed consent is refused unless the GCP project is heisreal-dev (the project
# surrealdb.tf checks against the overlay's settings.env). Mock providers: nothing reaches a
# cluster or the network. Only a refusal can be tested this way: a plan that passes validation
# needs the real overlay's manifests (tools/scripts/tf.sh cluster plan covers that).

mock_provider "kubernetes" {}
mock_provider "helm" {}
mock_provider "kustomization" {}

variables {
  surrealdb_overlay_path = "../../../k8s/surrealdb/overlays/gke-dev"
  eso_image_repository   = "example/external-secrets"
  schema_dir             = "../../../../libs/database/schema"
  dpa_dir                = "../../../../libs/legal/dpa"
  dev_consent_relaxed    = true
}

# Another project. (The dev overlay doesn't match it either, so its precondition fails too.)
run "refused_outside_dev" {
  command = plan
  variables {
    surrealdb_expected_settings = { GCP_PROJECT = "heisreal-prod" }
  }
  expect_failures = [var.dev_consent_relaxed, data.kustomization_overlay.surrealdb]
}
