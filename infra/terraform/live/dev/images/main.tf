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
  # Same formula as tools/scripts/image-tag.sh (used by CI); keep them in step.
  content_hash = {
    for s in local.services : s => substr(sha1(join("", [
      for f in sort(fileset("${local.app_root}/${s}/dist", "**")) :
      filesha1("${local.app_root}/${s}/dist/${f}")
      if !endswith(f, ".map")
    ])), 0, 12)
  }
}

# Build + push with the Docker CLI (the kreuzwerker/docker provider can't read
# back builds from Docker's containerd image store). Registry login uses a
# throwaway DOCKER_CONFIG with your short-lived Google token, deleted after.
resource "terraform_data" "image" {
  for_each = local.services

  triggers_replace = local.content_hash[each.value]

  provisioner "local-exec" {
    interpreter = ["bash", "-euo", "pipefail", "-c"]
    environment = {
      IMAGE    = "${local.registry}/${each.value}:${local.content_hash[each.value]}"
      CONTEXT  = "${local.app_root}/${each.value}/dist"
      REGISTRY = split("/", local.registry)[0]
      TOKEN    = ephemeral.google_client_config.current.access_token
    }
    command = <<-EOT
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
  image_name    = "${each.value}:${local.content_hash[each.value]}"

  depends_on = [terraform_data.image]
}

output "images" {
  description = "Pushed snapshot images by digest."
  value = {
    for s in local.services :
    s => data.google_artifact_registry_docker_image.service[s].self_link
  }
}
