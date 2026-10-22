# --- tf-bunny: the bunny root only (D57 C) ---------------------------------
# The only CI identity that can read the bunny root's state (state.tf), the
# `bunny-*` secrets and the tofu-bunny key (kms.tf). CI gets it only on main, in
# tofu-apply.yml and tofu-drift.yml (bunny_gate.cel.tftpl); PRs never plan bunny.
# Developers impersonate it (developers_impersonate), so `tf.sh bunny plan`
# works from any branch. tf-deployer gets no grants on any of this. It could
# grant itself access through its service-account roles; that is accepted (D57).
resource "google_service_account" "tf_bunny" {
  project      = google_project.this.project_id
  account_id   = "tf-bunny"
  display_name = "OpenTofu bunny root (CI on main, developers)"
}

resource "google_service_account_iam_member" "tf_bunny_wif" {
  service_account_id = google_service_account.tf_bunny.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.pool}/attribute.bunny_gate/allowed"
}

# Read IAM policies for the bunny root's never-public guard (bucket, secrets,
# keyring and keys, project). Holds no storage.buckets.get or secrets.get.
resource "google_project_iam_member" "tf_bunny_security_reviewer" {
  project = google_project.this.project_id
  role    = "roles/iam.securityReviewer"
  member  = google_service_account.tf_bunny.member
}

# Creating a secret is checked on the project and can't be limited by name.
# Creating one gives no access to existing secrets.
resource "google_project_iam_custom_role" "bunny_parent" {
  project     = google_project.this.project_id
  role_id     = "bunnyParent"
  title       = "OpenTofu bunny root: create secrets"
  permissions = ["secretmanager.secrets.create"]
}

resource "google_project_iam_member" "tf_bunny_parent" {
  project = google_project.this.project_id
  role    = google_project_iam_custom_role.bunny_parent.name
  member  = google_service_account.tf_bunny.member
}

# The exact opposite of the deployer's not-bunny-secrets: `bunny-*` secrets and
# their versions only. Manage them (tf_secrets) and read them: the bunny root
# reads the account key, `tf.sh bunny-mask` reads every `bunny-*` secret.
locals {
  only_bunny_secrets = {
    title = "only-bunny-secrets"
    expression = join(" && ", [
      "(resource.type == 'secretmanager.googleapis.com/Secret' || resource.type == 'secretmanager.googleapis.com/SecretVersion')",
      "(${join(" || ", [for p in local.bunny_secret_prefixes : "resource.name.startsWith('${p}')"])})",
    ])
  }
}

resource "google_project_iam_member" "tf_bunny_secrets" {
  for_each = {
    manage = google_project_iam_custom_role.tf_secrets.name
    access = "roles/secretmanager.secretAccessor"
  }

  project = google_project.this.project_id
  role    = each.value
  member  = google_service_account.tf_bunny.member

  condition {
    title      = local.only_bunny_secrets.title
    expression = local.only_bunny_secrets.expression
  }
}
