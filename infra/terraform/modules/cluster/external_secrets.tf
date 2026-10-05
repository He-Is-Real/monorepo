# External Secrets Operator: syncs Secret Manager secrets into Kubernetes
# Secrets for SurrealDB and its Jobs. Controller only (no webhook or cert
# controller) and small requests to keep Autopilot cost down.

resource "kubernetes_namespace_v1" "external_secrets" {
  metadata {
    name = "external-secrets"
  }
}

resource "kubernetes_resource_quota_v1" "external_secrets" {
  metadata {
    name      = "external-secrets-cap"
    namespace = kubernetes_namespace_v1.external_secrets.metadata[0].name
  }
  spec {
    hard = {
      pods              = "2"
      "requests.cpu"    = "200m"
      "requests.memory" = "512Mi"
    }
  }
}

resource "helm_release" "external_secrets" {
  name       = "external-secrets"
  namespace  = kubernetes_namespace_v1.external_secrets.metadata[0].name
  repository = "https://charts.external-secrets.io"
  chart      = "external-secrets"
  version    = var.eso_chart_version

  values = [yamlencode({
    installCRDs = true
    image = {
      repository = var.eso_image_repository
    }
    webhook = {
      create = false
    }
    certController = {
      create = false
    }
    nodeSelector = {
      "cloud.google.com/gke-spot" = "true"
    }
    resources = {
      requests = { cpu = "50m", memory = "128Mi" }
      limits   = { memory = "256Mi" }
    }
  })]

  depends_on = [kubernetes_resource_quota_v1.external_secrets]
}
