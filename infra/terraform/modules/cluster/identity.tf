# SurrealDB's identity config (D13 B cutover; modules/db-identity): the init template
# ConfigMap and its ExternalSecret are applied as copies named after the identity hash, and the
# StatefulSet (patched in surrealdb.tf) mounts that Secret and carries the hash, so a change
# restarts SurrealDB with the new startup init: old system users are removed before the server
# answers anything, and every session opened before ends with the old process. The pod can't
# start until ESO has rendered the new Secret, so it never runs a stale script. Rendered
# passwords stay in the cluster: Terraform only sees the template and secret names.

locals {
  # D48, D49: the environment comes from the GCP project the overlay and the gcp root agree on
  # (surrealdb.tf), not from a free-form input: heisreal-dev -> dev.
  environment = trimprefix(lookup(var.surrealdb_expected_settings, "GCP_PROJECT", ""), "heisreal-")

  init_template_id = one([
    for id, m in data.kustomization_overlay.surrealdb.manifests : id
    if jsondecode(m).kind == "ConfigMap" && jsondecode(m).metadata.name == "surrealdb-init-template"
  ])
  init_secret_id = one([
    for id, m in data.kustomization_overlay.surrealdb.manifests : id
    if jsondecode(m).kind == "ExternalSecret" && jsondecode(m).metadata.name == "surrealdb-init"
  ])
}

module "identity" {
  source = "../db-identity"

  # Hashed from the source files (not the rendered overlay, which the StatefulSet patch is part of).
  template         = file("${var.surrealdb_overlay_path}/../../base/init.surql.tmpl")
  external_secrets = file("${var.surrealdb_overlay_path}/../gke/externalsecrets.yaml")
  rotation         = var.identity_rotation
  environment      = local.environment
  dev_seed_login   = var.dev_seed_login
  config_map       = jsondecode(data.kustomization_overlay.surrealdb.manifests[local.init_template_id])
  external_secret  = jsondecode(data.kustomization_overlay.surrealdb.manifests[local.init_secret_id])
}

# create_before_destroy: the new template and Secret exist before the old ones go (deleting the
# old ExternalSecret also deletes its Secret, which the old pod may still have mounted).
resource "kustomization_resource" "init_template" {
  manifest = jsonencode(module.identity.config_map)

  depends_on = [kustomization_resource.p0]
  lifecycle {
    create_before_destroy = true
  }
}

resource "kustomization_resource" "init_secret" {
  manifest = jsonencode(module.identity.external_secret)

  depends_on = [kustomization_resource.p0, kustomization_resource.init_template]
  lifecycle {
    create_before_destroy = true
  }
}

output "identity_config" {
  description = "The identity config hash SurrealDB should be running with (pod annotation heisreal.today/identity-config)."
  value       = module.identity.hash
}
