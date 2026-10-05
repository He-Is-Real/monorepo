# Dev in-cluster configuration: External Secrets Operator, SurrealDB (from the
# gke-dev Kustomize overlay).
#
# Stop/start SurrealDB (disk is kept):
#   terraform apply -var surrealdb_replicas=0   # or =1
# Back up now:
#   terraform apply -var backup_run=<new id>

terraform {
  required_version = ">= 1.11"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.5"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.3"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.3"
    }
    kustomization = {
      source  = "kbst/kustomization"
      version = "~> 0.9"
    }
  }
}

provider "google" {
  project = "heisreal-dev"
  region  = "europe-west2"
}

data "terraform_remote_state" "gcp" {
  backend = "gcs"
  config = {
    bucket = "heisreal-dev-tfstate"
    prefix = "dev/gcp"
  }
}

# Ephemeral: the caller's short-lived Google token is used for this run only
# and never written to state.
ephemeral "google_client_config" "current" {}

locals {
  gcp = data.terraform_remote_state.gcp.outputs.gcp

  # IAM-protected DNS endpoint with a publicly trusted certificate; the
  # caller's own Google token authenticates (no kubeconfig files, no keys).
  cluster_host = "https://${local.gcp.cluster_dns_endpoint}"
  token        = ephemeral.google_client_config.current.access_token
}

provider "kubernetes" {
  host  = local.cluster_host
  token = local.token
}

provider "helm" {
  kubernetes = {
    host  = local.cluster_host
    token = local.token
  }
}

provider "kustomization" {
  kubeconfig_raw = yamlencode({
    apiVersion      = "v1"
    kind            = "Config"
    current-context = "gke"
    clusters        = [{ name = "gke", cluster = { server = local.cluster_host } }]
    users           = [{ name = "gke", user = { token = local.token } }]
    contexts        = [{ name = "gke", context = { cluster = "gke", user = "gke" } }]
  })
}

variable "surrealdb_replicas" {
  description = "1 = running, 0 = stopped (disk kept)."
  type        = number
  default     = 1
}

variable "backup_run" {
  description = "Set to a new id to run a SurrealDB backup now (e.g. -var backup_run=20261005a)."
  type        = string
  default     = ""
}

module "cluster" {
  source = "../../../modules/cluster"

  surrealdb_overlay_path = "${path.root}/../../../../k8s/surrealdb/overlays/gke-dev"
  surrealdb_replicas     = var.surrealdb_replicas
  backup_run             = var.backup_run

  surrealdb_expected_settings = {
    GCP_PROJECT          = "heisreal-dev"
    GKE_CLUSTER_NAME     = local.gcp.cluster_name
    GKE_CLUSTER_LOCATION = local.gcp.cluster_location
    BACKUP_BUCKET        = local.gcp.backups_bucket
    SECRETS_GSA          = local.gcp.surrealdb_secrets_gsa
    BACKUP_GSA           = local.gcp.surrealdb_backup_gsa
    RUN_SUBNET_CIDR      = local.gcp.run_subnet_cidr
  }

  eso_image_repository = "${local.gcp.registry.ghcr}/external-secrets/external-secrets"
}
