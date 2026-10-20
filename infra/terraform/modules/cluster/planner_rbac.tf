# D42: the automatic cluster plan (terraform-plan.yml, environment cluster-plan) runs as
# tf-cluster-planner. The kustomization provider diffs with server-side dry runs, which Kubernetes
# authorises exactly like the real request, so this Role grants real create/patch on these kinds
# in `database` only: treat the planner as having apply rights in this namespace. Its token can
# only be minted through the gated WIF binding (modules/bootstrap/ci_identity.tf).
#
# Kinds: every kind the overlay and migration.tf/identity.tf apply in `database`, i.e. what the
# CI log's dry-run errors listed (ConfigMaps for the migration bundle and init template,
# ExternalSecrets, ServiceAccounts) plus the rest of the overlay (StatefulSet, Service, Jobs,
# CronJob, NetworkPolicies, ResourceQuota, SecretStore). Verbs: create (new objects) and patch
# (changed ones); reads come from roles/container.viewer. No Secrets: the overlay has none (ESO
# creates them) and nothing in the plan reads them. No delete, no cluster-scoped rights: a plan
# that needs them (e.g. a changed Namespace or the ESO Helm release) fails, and is planned by
# the manual workflow instead.

resource "kubernetes_role_v1" "cluster_planner" {
  count = var.cluster_planner_email == "" ? 0 : 1

  metadata {
    name      = "terraform-cluster-plan"
    namespace = "database"
  }
  rule {
    api_groups = [""]
    resources  = ["configmaps", "serviceaccounts", "services", "resourcequotas"]
    verbs      = ["create", "patch"]
  }
  rule {
    api_groups = ["apps"]
    resources  = ["statefulsets"]
    verbs      = ["create", "patch"]
  }
  rule {
    api_groups = ["batch"]
    resources  = ["jobs", "cronjobs"]
    verbs      = ["create", "patch"]
  }
  rule {
    api_groups = ["networking.k8s.io"]
    resources  = ["networkpolicies"]
    verbs      = ["create", "patch"]
  }
  rule {
    api_groups = ["external-secrets.io"]
    resources  = ["externalsecrets", "secretstores"]
    verbs      = ["create", "patch"]
  }

  depends_on = [kustomization_resource.p0] # the namespace
}

resource "kubernetes_role_binding_v1" "cluster_planner" {
  count = var.cluster_planner_email == "" ? 0 : 1

  metadata {
    name      = "terraform-cluster-plan"
    namespace = "database"
  }
  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.cluster_planner[0].metadata[0].name
  }
  subject {
    kind      = "User"
    name      = var.cluster_planner_email # GKE maps the Google identity's email to the user name
    api_group = "rbac.authorization.k8s.io"
  }
}
