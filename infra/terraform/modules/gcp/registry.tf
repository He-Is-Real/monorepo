# Our images, plus pull-through caches for Docker Hub and ghcr.io so private
# nodes never need internet access (no Cloud NAT).

resource "google_artifact_registry_repository" "apps" {
  project       = var.project_id
  location      = var.region
  repository_id = "apps"
  format        = "DOCKER"
  description   = "He Is Real service images (built by CI on main)"
  labels        = local.labels

  docker_config {
    immutable_tags = true # a tag always means the same build
  }

  # Only changed services are pushed, so 20 versions per service is many
  # merges of rollback room. Prod will need pinned images kept explicitly.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 20
    }
  }

  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "2592000s" # 30 days
    }
  }
}

# Development ("snapshot") images: built on a local developer machine (the
# images root) or by snapshot-images.yml on any branch. Dev may run them;
# prod never accepts this repository.
resource "google_artifact_registry_repository" "apps_scratch" {
  project       = var.project_id
  location      = var.region
  repository_id = "apps-scratch"
  format        = "DOCKER"
  description   = "Development images from any branch (dev only)"
  labels        = local.labels

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 15
    }
  }

  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "1209600s" # 14 days
    }
  }
}

resource "google_artifact_registry_repository" "dockerhub" {
  project       = var.project_id
  location      = var.region
  repository_id = "dockerhub"
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"
  description   = "Pull-through cache of Docker Hub"
  labels        = local.labels

  remote_repository_config {
    docker_repository {
      public_repository = "DOCKER_HUB"
    }
  }
}

resource "google_artifact_registry_repository" "ghcr" {
  project       = var.project_id
  location      = var.region
  repository_id = "ghcr"
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"
  description   = "Pull-through cache of ghcr.io"
  labels        = local.labels

  remote_repository_config {
    docker_repository {
      custom_repository {
        uri = "https://ghcr.io"
      }
    }
  }
}

resource "google_artifact_registry_repository_iam_member" "nodes_read" {
  for_each = {
    apps      = google_artifact_registry_repository.apps.name
    dockerhub = google_artifact_registry_repository.dockerhub.name
    ghcr      = google_artifact_registry_repository.ghcr.name
  }

  project    = var.project_id
  location   = var.region
  repository = each.value
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.gke_nodes.member
}

resource "google_artifact_registry_repository_iam_member" "ci_push" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.apps.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${var.ci_image_pusher_email}"
}

resource "google_artifact_registry_repository_iam_member" "ci_snapshot_push" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.apps_scratch.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${var.ci_snapshot_pusher_email}"
}
