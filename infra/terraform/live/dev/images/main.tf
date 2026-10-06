# Snapshot images from a local developer machine: builds each service image
# from its pruned Nx output and pushes it to apps-scratch (development builds;
# dev can run them, prod never). Nothing reads this root's state.
#
#   pnpm nx run-many -t prune -p api-read api-write api-admin workflow
#   terraform apply
#
# Then run it in dev: set the service to "snapshot" in
# live/dev/gcp/images.auto.tfvars, or apply gcp once with
#   -var 'image_overrides={"api-read"="snapshot"}'.

terraform {
  required_version = ">= 1.11"
  required_providers {
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 8.5"
    }
  }
}

provider "google" {
  project = "heisreal-dev"
  region  = "europe-west2"
}

# Ephemeral: the registry login token is never written to state.
ephemeral "google_client_config" "current" {}

data "terraform_remote_state" "gcp" {
  backend = "gcs"
  config = {
    bucket = "heisreal-dev-tfstate"
    prefix = "dev/gcp"
  }
}

locals {
  registry = data.terraform_remote_state.gcp.outputs.gcp.registry.apps_scratch
  services = toset(["api-read", "api-write", "api-admin", "workflow"])
  app_root = "${path.root}/../../../../../apps"

  # Tag = hash of the pruned build output, so unchanged builds aren't re-pushed.
  tag = { for s in local.services : s => data.external.image[s].result.tag }
}

# Tag from tools/scripts/image-tag.sh (the script CI uses, so the two can't
# drift), and whether that tag is still in apps-scratch: its cleanup policy
# deletes old snapshots, and a deleted tag must be pushed again.
data "external" "image" {
  for_each = local.services

  program = ["${path.module}/image-state.sh"]
  query = {
    service    = each.value
    repository = local.registry
  }
}

# Build + push with the Docker CLI (the kreuzwerker/docker provider can't read
# back builds from Docker's containerd image store). Registry login uses a
# throwaway DOCKER_CONFIG with your short-lived Google token, deleted after.
resource "terraform_data" "image" {
  for_each = local.services

  # A tag missing from the registry (new, or deleted by cleanup) changes the
  # trigger, so it is pushed. The plan after a push shows one more no-op
  # replacement (missing flips back to false); the provisioner skips it.
  triggers_replace = {
    tag     = local.tag[each.value]
    missing = data.external.image[each.value].result.exists == "false"
  }

  provisioner "local-exec" {
    interpreter = ["bash", "-euo", "pipefail", "-c"]
    environment = {
      IMAGE    = "${local.registry}/${each.value}:${local.tag[each.value]}"
      CONTEXT  = "${local.app_root}/${each.value}/dist"
      REGISTRY = split("/", local.registry)[0]
      TOKEN    = ephemeral.google_client_config.current.access_token
    }
    command = <<-EOT
      # Replaced only because a re-pushed tag is back: nothing to do.
      if gcloud artifacts docker images describe "$IMAGE" --quiet > /dev/null 2>&1; then
        echo "$IMAGE is already in the registry, skipping"
        exit 0
      fi
      # Pin the engine of the current Docker context (e.g. Docker Desktop):
      # the throwaway DOCKER_CONFIG below would otherwise reset it to default.
      export DOCKER_HOST="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
      docker build -t "$IMAGE" "$CONTEXT"
      export DOCKER_CONFIG="$(mktemp -d)"
      trap 'rm -rf "$DOCKER_CONFIG"' EXIT
      printf '%s' "$TOKEN" | docker login -u oauth2accesstoken --password-stdin "https://$REGISTRY"
      docker push "$IMAGE"
    EOT
  }
}

# The pushed image as Artifact Registry sees it (gives the immutable digest).
data "google_artifact_registry_docker_image" "service" {
  for_each = local.services

  location      = "europe-west2"
  repository_id = "apps-scratch"
  image_name    = "${each.value}:${local.tag[each.value]}"

  depends_on = [terraform_data.image]
}

output "images" {
  description = "Pushed snapshot images by digest."
  value = {
    for s in local.services :
    s => data.google_artifact_registry_docker_image.service[s].self_link
  }
}
