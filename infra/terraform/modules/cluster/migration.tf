# Schema migrations (D14): the migrate Job from the overlay, re-applied as
# surrealdb-migrate-<hash> with its bundle in surrealdb-migration-<hash>
# (modules/db-migration). A change to the schema, a data script, a DPA text,
# the Clerk key, the runner or the Job spec gives a new hash: Terraform deletes
# the previous Job and ConfigMap and creates the new ones, and the Job runs.
# No change, no diff. Terraform doesn't wait for the Job: check it with
# kubectl (infra/k8s/surrealdb/README.md, "Schema migrations").

locals {
  migrate_template_id = one([
    for id, m in data.kustomization_overlay.surrealdb.manifests : id
    if jsondecode(m).kind == "Job" && jsondecode(m).metadata.name == "surrealdb-migrate"
  ])
}

module "migration" {
  source = "../db-migration"

  schema_dir           = var.schema_dir
  dpa_dir              = var.dpa_dir
  clerk_jwt_public_key = var.clerk_jwt_public_key
  identity_hash        = module.identity.hash
  environment          = local.environment
  dev_consent_relaxed  = var.dev_consent_relaxed
  # D75: dev's placeholder privacy document and consent forms.
  dev_legal_placeholders = var.dev_legal_placeholders
  # D49: the Job waits for exactly the system users the init creates.
  extra_system_users = var.dev_seed_login ? ["dev_seed"] : []
  job_template       = jsondecode(data.kustomization_overlay.surrealdb.manifests[local.migrate_template_id])
}

resource "kustomization_resource" "migration_bundle" {
  manifest = jsonencode(module.migration.config_map)

  depends_on = [kustomization_resource.p0] # the namespace
}

# After p1 (the StatefulSet, the migrator Secret, the service account, the
# NetworkPolicy) and the identity config. The runner waits until the
# identity-check sidecar has verified this identity config (SurrealDB restarted
# with it: old users removed, old sessions gone, intended passwords work) and
# checks everything before it changes anything.
resource "kustomization_resource" "migrate" {
  manifest = jsonencode(module.migration.job)

  # Replaced whenever the hash changes, with Terraform's default order: the old Job is deleted
  # before the new one is created. Its pod may still be stopping, so overlap is possible; the
  # runner's fencing token (taken from the database) makes the later run win.
  depends_on = [kustomization_resource.p1, kustomization_resource.migration_bundle, kustomization_resource.init_secret]
}

output "migrate_job" {
  description = "The current migrate Job (kubectl -n database get job <name>)."
  value       = module.migration.job_name
}
