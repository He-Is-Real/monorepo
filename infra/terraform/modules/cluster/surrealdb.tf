# SurrealDB from the Kustomize overlay, with the replica count controlled
# here (var.surrealdb_replicas) so stopping/starting is a Terraform change.

locals {
  overlay_settings = {
    for kv in regexall("(?m)^([A-Z_]+)=(.*)$", file("${var.surrealdb_overlay_path}/settings.env")) :
    kv[0] => kv[1]
  }
}

data "kustomization_overlay" "surrealdb" {
  resources = [var.surrealdb_overlay_path]

  lifecycle {
    precondition {
      condition     = alltrue([for k, v in var.surrealdb_expected_settings : lookup(local.overlay_settings, k, null) == v])
      error_message = "settings.env in the overlay doesn't match Terraform: expected ${jsonencode(var.surrealdb_expected_settings)}."
    }
  }

  patches {
    target {
      kind = "StatefulSet"
      name = "surrealdb"
    }
    patch = jsonencode([{
      op    = "replace"
      path  = "/spec/replicas"
      value = var.surrealdb_replicas
    }])
  }
}

# Apply in dependency order: namespaces/CRDs, then everything else, then
# webhooks (kbst's priority groups).
resource "kustomization_resource" "p0" {
  for_each = data.kustomization_overlay.surrealdb.ids_prio[0]
  manifest = data.kustomization_overlay.surrealdb.manifests[each.value]

  depends_on = [helm_release.external_secrets] # ExternalSecret/SecretStore CRDs
}

resource "kustomization_resource" "p1" {
  for_each = data.kustomization_overlay.surrealdb.ids_prio[1]
  manifest = data.kustomization_overlay.surrealdb.manifests[each.value]

  # The init Job is replaced, not patched, when its spec changes (Jobs are immutable).
  wait = false

  depends_on = [kustomization_resource.p0]
}

resource "kustomization_resource" "p2" {
  for_each = data.kustomization_overlay.surrealdb.ids_prio[2]
  manifest = data.kustomization_overlay.surrealdb.manifests[each.value]

  depends_on = [kustomization_resource.p1]
}

# On-demand backup: a one-off Job from the CronJob's own template (same
# identity, export and upload), so a backup can be taken without kubectl.
locals {
  backup_cronjob = one([
    for m in values(data.kustomization_overlay.surrealdb.manifests) : jsondecode(m)
    if jsondecode(m).kind == "CronJob" && jsondecode(m).metadata.name == "surrealdb-backup"
  ])
}

resource "kustomization_resource" "backup_now" {
  count = var.backup_run == "" ? 0 : 1

  manifest = jsonencode({
    apiVersion = "batch/v1"
    kind       = "Job"
    metadata = {
      name      = "surrealdb-backup-${var.backup_run}"
      namespace = local.backup_cronjob.metadata.namespace
      labels    = local.backup_cronjob.metadata.labels
    }
    spec = local.backup_cronjob.spec.jobTemplate.spec
  })

  depends_on = [kustomization_resource.p1]
}
