# Keyless GitHub Actions access (Workload Identity Federation). GitHub issues a
# short-lived OIDC token per job; Google exchanges it for a short-lived token of
# one of these service accounts, depending on *what* the job is:
#
#   tf-planner          any workflow in this repo              read-only; automatic gcp plans
#   tf-cluster-planner  environment cluster-plan (reviewer      dry runs only, in the database
#                       approval), tofu-plan.yml on PRs        namespace; automatic cluster plans
#   ci-image-pusher     images.yml on a push to main          push to apps
#   ci-snapshot-pusher  manual snapshot-images.yml, any branch push to apps-scratch only
#   tf-deployer         tofu-apply.yml / tofu-drift.yml on     gcp, images and cluster applies
#                       main
#   tf-bunny            tofu-apply.yml / tofu-drift.yml on     the bunny root only (tf_bunny.tf)
#                       main
#   ci-dev-seeder       reset-dev-data.yml / dev-behavioural-  start the dev-seed Job (D50; the
#                       tests.yml dispatched on main           gcp root grants it on that Job only)
#
# The gates are computed from the token's claims, so a workflow on another
# branch, another workflow file, or an automatic trigger cannot obtain the
# powerful roles.

resource "google_iam_workload_identity_pool" "github" {
  project                   = google_project.this.project_id
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.this]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = google_project.this.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "GitHub Actions OIDC"

  # Only tokens from this exact repository are accepted at all.
  attribute_condition = "assertion.repository_id == '${var.github_repository_id}'"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
    # workflow_ref is the top-level workflow file (callers of _images.yml).
    "attribute.push_gate" = join("", [
      "(assertion.ref == 'refs/heads/main' && assertion.event_name == 'push'",
      " && assertion.workflow_ref == '${var.github_repository}/.github/workflows/images.yml@refs/heads/main')",
      " ? 'allowed' : 'denied'",
    ])
    "attribute.snapshot_gate" = join("", [
      "(assertion.event_name == 'workflow_dispatch'",
      " && assertion.workflow_ref.startsWith('${var.github_repository}/.github/workflows/snapshot-images.yml@'))",
      " ? 'allowed' : 'denied'",
    ])
    # D42: the automatic cluster plan. The boundary here is the `cluster-plan` environment (a
    # required reviewer in GitHub: no run gets this claim without approval) and the repository.
    # The workflow file and event are checked too, but on a pull request the workflow comes from
    # the PR branch, so they are no boundary; the Kubernetes admission policy is (the identity
    # can only send dry runs: modules/cluster/planner_dry_run_policy.yaml.tftpl). Forks get no
    # OIDC token. has(): other workflows' tokens have no environment claim.
    # In cluster_plan_gate.cel.tftpl (one source: tests/cluster-plan-gate.test.mjs evaluates it
    # with claim fixtures). workflow_ref, not job_workflow_ref: the latter is documented for
    # reusable workflows (it has been present for plain jobs too: deploy_gate below uses it).
    "attribute.cluster_plan_gate" = trimspace(templatefile("${path.module}/cluster_plan_gate.cel.tftpl", {
      repository = var.github_repository
    }))
    # tf-deployer and tf-bunny: main only, in the apply and drift workflows. job_workflow_ref is what
    # the deploy gate has always checked; for a plain job it equals workflow_ref, the fallback if a
    # workflow_run token ever lacks it. Tests: tests/{deploy,bunny}-gate.test.mjs.
    "attribute.deploy_gate" = trimspace(templatefile("${path.module}/deploy_gate.cel.tftpl", {
      repository = var.github_repository
    }))
    "attribute.bunny_gate" = trimspace(templatefile("${path.module}/bunny_gate.cel.tftpl", {
      repository = var.github_repository
    }))
    # D50: ci-dev-seeder. Only "Reset dev data" and "Dev behavioural tests" dispatched on main,
    # so branch code never gets it; in those workflows only the reset job asks for an OIDC token
    # (the test job can't sign in at all). Not as a reusable workflow called from elsewhere.
    # Tests: tests/dev-seed-gate.test.mjs.
    "attribute.dev_seed_gate" = trimspace(templatefile("${path.module}/dev_seed_gate.cel.tftpl", {
      repository = var.github_repository
    }))
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

locals {
  pool = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}"
}

# --- planner: read-only, used by automatic plans ---------------------------
resource "google_service_account" "tf_planner" {
  project      = google_project.this.project_id
  account_id   = "tf-planner"
  display_name = "Terraform planner (CI, read-only)"
}

resource "google_project_iam_member" "tf_planner" {
  for_each = toset([
    "roles/viewer",
    "roles/iam.securityReviewer", # read IAM policies for the diff
  ])
  project = google_project.this.project_id
  role    = each.value
  member  = google_service_account.tf_planner.member
}

resource "google_service_account_iam_member" "tf_planner_wif" {
  service_account_id = google_service_account.tf_planner.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.pool}/attribute.repository/${var.github_repository}"
}

# --- cluster planner: automatic cluster plans (D42) ------------------------
# Separate from tf-planner. In Kubernetes it has only what
# modules/cluster/planner_dry_run_policy.yaml.tftpl gives it: get/create/patch
# on the overlay's kinds in `database` (no Secrets), with an admission policy
# that rejects anything but dry runs. Its Google IAM is just enough to reach
# the cluster: no Kubernetes IAM role (container.viewer would add reads
# elsewhere), no Secret Manager, read-only state. Only the cluster_plan_gate
# above can impersonate it.
resource "google_service_account" "tf_cluster_planner" {
  project      = google_project.this.project_id
  account_id   = "tf-cluster-planner"
  display_name = "Terraform cluster planner (CI, cluster-plan environment)"
}

resource "google_project_iam_custom_role" "cluster_connect" {
  project     = google_project.this.project_id
  role_id     = "gkeClusterConnect"
  title       = "GKE: reach the cluster's API (DNS endpoint), nothing inside"
  permissions = ["container.clusters.get", "container.clusters.connect"]
}

resource "google_project_iam_member" "tf_cluster_planner" {
  project = google_project.this.project_id
  role    = google_project_iam_custom_role.cluster_connect.name
  member  = google_service_account.tf_cluster_planner.member
}

resource "google_service_account_iam_member" "tf_cluster_planner_wif" {
  service_account_id = google_service_account.tf_cluster_planner.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.pool}/attribute.cluster_plan_gate/allowed"
}

# --- image pusher: push to main only ---------------------------------------
# Granted writer on the apps repository by the gcp root (which owns the repo).
resource "google_service_account" "ci_image_pusher" {
  project      = google_project.this.project_id
  account_id   = "ci-image-pusher"
  display_name = "CI image pusher (main branch pushes)"
}

resource "google_service_account_iam_member" "ci_image_pusher_wif" {
  service_account_id = google_service_account.ci_image_pusher.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.pool}/attribute.push_gate/allowed"
}

# --- snapshot pusher: development images from any branch -------------------
# Branch code is untrusted, so this identity can only write apps-scratch
# (granted by the gcp root), which prod never accepts.
resource "google_service_account" "ci_snapshot_pusher" {
  project      = google_project.this.project_id
  account_id   = "ci-snapshot-pusher"
  display_name = "CI snapshot pusher (any branch, apps-scratch only)"
}

resource "google_service_account_iam_member" "ci_snapshot_pusher_wif" {
  service_account_id = google_service_account.ci_snapshot_pusher.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.pool}/attribute.snapshot_gate/allowed"
}

# --- dev seeder: "Reset dev data" (D50) -------------------------------------
# Starts the dev-seed Cloud Run Job (D49), which resets dev to dummy data. No project role: the
# gcp root grants it jobsExecutor and viewer on that one Job only. No approval step: it only
# touches dummy data in dev.
resource "google_service_account" "ci_dev_seeder" {
  project      = google_project.this.project_id
  account_id   = "ci-dev-seeder"
  display_name = "CI dev seeder (Reset dev data: start the dev-seed Job)"
}

resource "google_service_account_iam_member" "ci_dev_seeder_wif" {
  service_account_id = google_service_account.ci_dev_seeder.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.pool}/attribute.dev_seed_gate/allowed"
}

# --- deployer: manual applies ----------------------------------------------
# Only what the gcp, cluster and stripe roots manage. It can't read secret values
# or backups (custom roles below leave out versions.access and objects.*), except
# the one key the stripe root runs with (stripe.tf), and it
# can only grant the one project role Terraform uses. GKE admin still lets it
# read in-cluster Kubernetes Secrets, which ESO fills from Secret Manager.
resource "google_service_account" "tf_deployer" {
  project      = google_project.this.project_id
  account_id   = "tf-deployer"
  display_name = "Terraform deployer (manual apply job)"
}

# Per-resource permissions only: the grant below is conditioned on the
# resource's name. Create and list are authorised against the parent project,
# where a secret or bucket name doesn't exist, so they're in tf_parent instead.
resource "google_project_iam_custom_role" "tf_secrets" {
  project = google_project.this.project_id
  role_id = "terraformSecretsManager"
  title   = "Terraform: manage secrets without reading them"
  permissions = [
    "secretmanager.secrets.delete",
    "secretmanager.secrets.get",
    "secretmanager.secrets.getIamPolicy",
    "secretmanager.secrets.setIamPolicy",
    "secretmanager.secrets.update",
    "secretmanager.versions.add",
    "secretmanager.versions.destroy",
    "secretmanager.versions.disable",
    "secretmanager.versions.enable",
    "secretmanager.versions.get",
    "secretmanager.versions.list",
  ]
}

resource "google_project_iam_custom_role" "tf_buckets" {
  project = google_project.this.project_id
  role_id = "terraformBucketsManager"
  title   = "Terraform: manage buckets without reading objects"
  permissions = [
    "storage.buckets.delete",
    "storage.buckets.get",
    "storage.buckets.getIamPolicy",
    "storage.buckets.setIamPolicy",
    "storage.buckets.update",
  ]
}

resource "google_project_iam_member" "tf_deployer" {
  for_each = toset([
    "roles/viewer", # read everything for refresh (no secret values, no objects)
    "roles/artifactregistry.admin",
    "roles/compute.networkAdmin",
    "roles/compute.securityAdmin", # firewall rules
    "roles/container.admin",       # cluster + Kubernetes objects
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountUser", # run Cloud Run / GKE nodes as their service accounts
    "roles/run.admin",
    "roles/cloudscheduler.admin", # the housekeeping Job's nightly trigger (modules/gcp/housekeeping.tf)
  ])
  project = google_project.this.project_id
  role    = each.value
  member  = google_service_account.tf_deployer.member
}

# Creating and listing secrets and buckets: checked on the project, so these
# can't be (and needn't be) limited by name. Creating a new resource gives no
# access to an existing one, and lists show names only.
resource "google_project_iam_custom_role" "tf_parent" {
  project = google_project.this.project_id
  role_id = "terraformParentScoped"
  title   = "Terraform: create and list secrets and buckets"
  permissions = [
    "secretmanager.secrets.create",
    "secretmanager.secrets.list",
    "storage.buckets.create",
    "storage.buckets.list",
  ]
}

resource "google_project_iam_member" "tf_deployer_parent" {
  project = google_project.this.project_id
  role    = google_project_iam_custom_role.tf_parent.name
  member  = google_service_account.tf_deployer.member
}

# The per-resource grants exclude what only developers may touch, because each
# role includes setIamPolicy: without the conditions the deployer could grant
# itself access to them. Excluded: the state bucket (bucket IAM and settings;
# this root owns it), so it can't lift the dev/bunny/ condition in state.tf; and
# every `bunny-*` secret and its versions (the account key in bunny.tf and the
# app keys from the bunny root), so it can't grant itself versions.access on
# them. Neither the gcp nor the cluster root manages either.
#
# Each expression applies the name check only to its own resource types
# (Google's recommended pattern), so a permission checked on another type is
# never caught by a missing name. Secret names use the project number; the
# project ID form is excluded too, in case a check uses it. tf-bunny gets the
# exact opposite (only-bunny-secrets, tf_bunny.tf).
locals {
  bunny_secret_prefixes = [
    "projects/${google_project.this.number}/secrets/bunny-",
    "projects/${google_project.this.project_id}/secrets/bunny-",
  ]
  deployer_fences = {
    secrets = {
      role  = google_project_iam_custom_role.tf_secrets.name
      title = "not-bunny-secrets"
      expression = join(" || ", [
        "!(resource.type == 'secretmanager.googleapis.com/Secret' || resource.type == 'secretmanager.googleapis.com/SecretVersion')",
        "(${join(" && ", [for p in local.bunny_secret_prefixes : "!resource.name.startsWith('${p}')"])})",
      ])
    }
    buckets = {
      role       = google_project_iam_custom_role.tf_buckets.name
      title      = "not-state-bucket"
      expression = "resource.type != 'storage.googleapis.com/Bucket' || resource.name != 'projects/_/buckets/${google_storage_bucket.tfstate.name}'"
    }
  }
}

resource "google_project_iam_member" "tf_deployer_custom" {
  for_each = local.deployer_fences

  project = google_project.this.project_id
  role    = each.value.role
  member  = google_service_account.tf_deployer.member

  condition {
    title      = each.value.title
    expression = each.value.expression
  }
}

# Project IAM admin, limited to granting the GKE node role (modules/gcp/gke.tf),
# so the deployer can't grant itself or anyone else more.
resource "google_project_iam_member" "tf_deployer_project_iam" {
  project = google_project.this.project_id
  role    = "roles/resourcemanager.projectIamAdmin"
  member  = google_service_account.tf_deployer.member

  condition {
    title      = "only-gke-node-role"
    expression = "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(['roles/container.defaultNodeServiceAccount'])"
  }
}

resource "google_service_account_iam_member" "tf_deployer_wif" {
  service_account_id = google_service_account.tf_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.pool}/attribute.deploy_gate/allowed"
}

# Developers can run OpenTofu as the CI identities, to reproduce CI or check
# that the deployer's roles are enough before relying on them. tools/scripts/tf.sh
# impersonates tf-deployer (gcp, images, cluster) and tf-bunny (bunny) by default.
# Owner has no iam.serviceAccounts.getAccessToken, so these grants are needed.
locals {
  impersonation_targets = {
    planner  = google_service_account.tf_planner.name
    deployer = google_service_account.tf_deployer.name
    bunny    = google_service_account.tf_bunny.name
  }
}

resource "google_service_account_iam_member" "developers_impersonate" {
  for_each = {
    for pair in setproduct(keys(local.impersonation_targets), var.developers) :
    "${pair[0]}/${pair[1]}" => { sa = pair[0], member = pair[1] }
  }

  service_account_id = local.impersonation_targets[each.value.sa]
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = each.value.member
}
