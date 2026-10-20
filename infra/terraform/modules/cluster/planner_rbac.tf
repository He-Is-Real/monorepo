# D42: the automatic cluster plan (terraform-plan.yml, environment cluster-plan) runs as
# tf-cluster-planner. Its Kubernetes rights: a namespaced Role for the kustomization provider's
# dry runs, and an admission policy that lets it send dry runs only. See
# planner_dry_run_policy.yaml.tftpl (the single source, also used by the kind test) and
# infra/terraform/README.md for the layering.

locals {
  planner_manifests = var.cluster_planner_email == "" ? [] : yamldecode(templatefile(
    "${path.module}/planner_dry_run_policy.yaml.tftpl", { planner = var.cluster_planner_email }
  ))
}

# The admission policy first: the Role must never exist without it.
resource "kustomization_resource" "planner_policy" {
  for_each = { for m in local.planner_manifests : m.kind => m if startswith(m.kind, "ValidatingAdmissionPolicy") }
  manifest = jsonencode(each.value)
}

resource "kustomization_resource" "planner_rbac" {
  for_each = { for m in local.planner_manifests : m.kind => m if contains(["Role", "RoleBinding"], m.kind) }
  manifest = jsonencode(each.value)

  depends_on = [kustomization_resource.p0, kustomization_resource.planner_policy]
}
