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
  generation           = terraform_data.migration_generation.output
  job_template         = jsondecode(data.kustomization_overlay.surrealdb.manifests[local.migrate_template_id])
}

# The generation fence (migrate.py): the plan time at which this bundle first appeared, kept in
# state until the bundle changes. Plan time follows the order in which bundles are deliberately
# applied, so a later apply always wins over an older Job still running; a rollback to an older
# commit is a new apply, so it gets a newer generation too. Not part of the hash (it would change
# the name on every plan), so the Job is replaced explicitly when it changes.
resource "terraform_data" "migration_generation" {
  input            = plantimestamp()
  triggers_replace = module.migration.hash
  lifecycle {
    ignore_changes = [input]
  }
}

resource "kustomization_resource" "migration_bundle" {
  manifest = jsonencode(module.migration.config_map)

  depends_on = [kustomization_resource.p0] # the namespace
}

# After p1 (the StatefulSet, the migrator Secret, the service account, the
# NetworkPolicy) and the identity config. The runner waits for SurrealDB to
# have restarted with this identity config (old users removed, old sessions
# gone) and checks everything before it changes anything.
resource "kustomization_resource" "migrate" {
  manifest = jsonencode(module.migration.job)

  depends_on = [kustomization_resource.p1, kustomization_resource.migration_bundle, kustomization_resource.init_secret]
  lifecycle {
    replace_triggered_by = [terraform_data.migration_generation]
  }
}

check "migration_held_back" {
  assert {
    condition     = length(module.migration.held_back) == 0
    error_message = "Data scripts held back until their parameters exist (the runner stops before the first): ${join(", ", module.migration.held_back)}. For 0002, add libs/legal/dpa/legacy-squarespace.md (D22)."
  }
}

output "migrate_job" {
  description = "The current migrate Job (kubectl -n database get job <name>)."
  value       = module.migration.job_name
}
