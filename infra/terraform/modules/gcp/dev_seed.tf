# D49: dev-seed, a Cloud Run Job that resets the dev database to the D47 dummy dataset
# (apps/dev-seed). Dev only (var.dev_seed refuses any other project). It reaches SurrealDB like
# the APIs (Direct VPC egress, the cluster's VPC-scope DNS name) and signs in as `dev_seed`, a
# dev-only system user the cluster root's dev_seed_login creates with this password. It never
# talks to Bunny: the media it points at were uploaded once (apps/dev-seed, upload-media).
#
# D50: ci-dev-seeder ("Reset dev data", "Dev behavioural tests") may start this one Job and
# watch its executions, nothing else: no overrides (jobsExecutor, not jobsExecutorWithOverrides),
# no other Job or service, no secrets, no logs. Starting a Job isn't a change to the
# infrastructure, so it needs no OpenTofu apply.

resource "google_service_account" "dev_seed" {
  count = var.dev_seed ? 1 : 0

  project      = var.project_id
  account_id   = "dev-seed"
  display_name = "Cloud Run Job: dev-seed (dummy data, dev only)"
}

resource "google_secret_manager_secret_iam_member" "dev_seed" {
  count = var.dev_seed ? 1 : 0

  project   = var.project_id
  secret_id = google_secret_manager_secret.surreal["surreal-dev-seed-password"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.dev_seed[0].member
}

resource "google_cloud_run_v2_job" "dev_seed" {
  count = var.dev_seed ? 1 : 0

  project             = var.project_id
  name                = "dev-seed"
  location            = var.region
  deletion_protection = false # dummy data only; nothing to protect
  labels              = local.labels

  template {
    task_count  = 1
    parallelism = 1

    template {
      service_account = google_service_account.dev_seed[0].email
      max_retries     = 0 # a reset is one transaction; a failure needs a look, not a retry
      timeout         = "600s"

      vpc_access {
        network_interfaces {
          network    = google_compute_network.this.id
          subnetwork = google_compute_subnetwork.run.id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      containers {
        # Until Release Images has built dev-seed and images.auto.tfvars selects it: Google's
        # sample job, which prints a line and exits.
        image = lookup(var.images, "dev-seed", "us-docker.pkg.dev/cloudrun/container/job:latest")

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name  = "DEV_SEED_ENVIRONMENT"
          value = var.environment
        }
        env {
          name  = "GCP_PROJECT"
          value = var.project_id
        }
        env {
          name  = "SURREAL_URL"
          value = "ws://${local.surrealdb_host}:8000"
        }
        env {
          name  = "SURREAL_NAMESPACE"
          value = "heisreal"
        }
        env {
          name  = "SURREAL_DATABASE"
          value = "main"
        }
        # A database-level system user (EDITOR), not a service record: the seed writes every
        # content table, and the schema's events still check every row (apps/dev-seed seed.ts).
        env {
          name  = "SURREAL_USER"
          value = "dev_seed"
        }
        env {
          name  = "SURREAL_PASSWORD_SECRET"
          value = "surreal-dev-seed-password"
        }
      }
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.dev_seed]
}

resource "google_cloud_run_v2_job_iam_member" "ci_dev_seeder" {
  for_each = var.dev_seed && var.ci_dev_seeder_email != "" ? toset([
    "roles/run.jobsExecutor", # run.jobs.run, run.executions.cancel
    "roles/run.viewer",       # read the Job and its executions (`--wait`), on this Job only
  ]) : toset([])

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.dev_seed[0].name
  role     = each.value
  member   = "serviceAccount:${var.ci_dev_seeder_email}"
}
