# D75: the placeholder privacy document and consent forms are refused unless the GCP project is
# heisreal-dev, like D48's switch (dev_consent.tftest.hcl). modules/db-migration refuses them
# again unless the environment is dev, and the database refuses them too
# (libs/database/integration/consent-forms.int-spec.ts). Mock providers: offline.

mock_provider "kubernetes" {}
mock_provider "helm" {}
mock_provider "kustomization" {}

variables {
  surrealdb_overlay_path = "../../../k8s/surrealdb/overlays/gke-dev"
  eso_image_repository   = "example/external-secrets"
  schema_dir             = "../../../../libs/database/schema"
  dpa_dir                = "../../../../libs/legal/dpa"
  dev_legal_placeholders = true
}

run "refused_outside_dev" {
  command = plan
  variables {
    surrealdb_expected_settings = { GCP_PROJECT = "heisreal-prod" }
  }
  expect_failures = [var.dev_legal_placeholders, data.kustomization_overlay.surrealdb]
}
