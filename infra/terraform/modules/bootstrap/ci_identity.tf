# Keyless GitHub Actions access (Workload Identity Federation). GitHub issues a
# short-lived OIDC token per job; Google exchanges it for a short-lived token of
# one of three service accounts, depending on *what* the job is:
#
#   tf-planner          any workflow in this repo              read-only; automatic plans
#   ci-image-pusher     images.yml on a push to main          push to apps
#   ci-snapshot-pusher  manual snapshot-images.yml, any branch push to apps-scratch only
#   tf-deployer         manual terraform-apply.yml on main     manual applies
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
    "attribute.deploy_gate" = join("", [
      "(assertion.ref == 'refs/heads/main' && assertion.event_name == 'workflow_dispatch'",
      " && assertion.job_workflow_ref == '${var.github_repository}/.github/workflows/terraform-apply.yml@refs/heads/main')",
      " ? 'allowed' : 'denied'",
    ])
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

# --- deployer: manual applies ----------------------------------------------
# Only what the gcp and cluster roots manage. It can't read secret values or
# backups (custom roles below leave out versions.access and objects.*), and it
# can only grant the one project role Terraform uses. GKE admin still lets it
# read in-cluster Kubernetes Secrets, which ESO fills from Secret Manager.
resource "google_service_account" "tf_deployer" {
  project      = google_project.this.project_id
  account_id   = "tf-deployer"
  display_name = "Terraform deployer (manual apply job)"
}

resource "google_project_iam_custom_role" "tf_secrets" {
  project = google_project.this.project_id
  role_id = "terraformSecretsManager"
  title   = "Terraform: manage secrets without reading them"
  permissions = [
    "secretmanager.secrets.create",
    "secretmanager.secrets.delete",
    "secretmanager.secrets.get",
    "secretmanager.secrets.getIamPolicy",
    "secretmanager.secrets.list",
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
    "storage.buckets.create",
    "storage.buckets.delete",
    "storage.buckets.get",
    "storage.buckets.getIamPolicy",
    "storage.buckets.list",
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
  ])
  project = google_project.this.project_id
  role    = each.value
  member  = google_service_account.tf_deployer.member
}

resource "google_project_iam_member" "tf_deployer_custom" {
  for_each = {
    secrets = google_project_iam_custom_role.tf_secrets.name
    buckets = google_project_iam_custom_role.tf_buckets.name
  }
  project = google_project.this.project_id
  role    = each.value
  member  = google_service_account.tf_deployer.member
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

# Developers can run Terraform as the CI identities, to reproduce CI or check
# that the deployer's roles are enough before relying on them.
resource "google_service_account_iam_member" "developers_impersonate" {
  for_each = {
    for pair in setproduct(["planner", "deployer"], var.developers) :
    "${pair[0]}/${pair[1]}" => { sa = pair[0], member = pair[1] }
  }

  service_account_id = each.value.sa == "planner" ? google_service_account.tf_planner.name : google_service_account.tf_deployer.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = each.value.member
}
