# Cloud KMS keys that encrypt OpenTofu state and saved plans (D54; each root's
# encryption.tf). Two keys, because the bunny root's state holds Bunny keys
# (AGENTS.md): only tf-bunny and developers can use tofu-bunny, so no other CI
# identity can open Bunny state even if it got the object. The other roots
# share tofu-state: a key per root would cost more and add nothing, since the
# state bucket's IAM (state.tf) already separates their states.
#
# OpenTofu calls Encrypt on every run and Decrypt when it reads, so every
# principal that reads a state needs EncrypterDecrypter on its key, planners
# too.
#
# Never disable or destroy a key version: rotation doesn't re-encrypt old
# states, plans or object generations, so each one still needs its version.
# Losing tofu-state loses every state but bunny's. Recovering a version
# scheduled for destruction: infra/terraform/README.md, "Encryption".
#
# prevent_destroy refuses a plan that would destroy these; destroy = false
# (stored as skip_destroy) makes OpenTofu forget them instead of destroying
# them if they ever leave the configuration.

resource "google_kms_key_ring" "tofu" {
  project  = google_project.this.project_id
  name     = "tofu"
  location = var.region

  lifecycle {
    prevent_destroy = true
    destroy         = false
  }

  depends_on = [google_project_service.this]
}

resource "google_kms_crypto_key" "state" {
  name                       = "tofu-state"
  key_ring                   = google_kms_key_ring.tofu.id
  purpose                    = "ENCRYPT_DECRYPT"
  rotation_period            = "31536000s" # yearly
  destroy_scheduled_duration = "10368000s" # 120 days, the maximum
  labels                     = local.labels

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  lifecycle {
    prevent_destroy = true
    destroy         = false
  }
}

resource "google_kms_crypto_key" "bunny" {
  name                       = "tofu-bunny"
  key_ring                   = google_kms_key_ring.tofu.id
  purpose                    = "ENCRYPT_DECRYPT"
  rotation_period            = "31536000s" # yearly
  destroy_scheduled_duration = "10368000s" # 120 days, the maximum
  labels                     = merge(local.labels, { component = "bunny" })

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  lifecycle {
    prevent_destroy = true
    destroy         = false
  }
}

# Authoritative per key. Developers also reach both keys through roles/owner
# (which includes disable and destroy: follow the rule above by hand).
locals {
  kms_key_users = {
    state = concat(var.developers, [
      google_service_account.tf_deployer.member,
      google_service_account.tf_planner.member,
      google_service_account.tf_cluster_planner.member,
    ])
    bunny = concat(var.developers, [google_service_account.tf_bunny.member])
  }
}

data "google_iam_policy" "kms_state" {
  binding {
    role    = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
    members = local.kms_key_users.state
  }
}

data "google_iam_policy" "kms_bunny" {
  binding {
    role    = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
    members = local.kms_key_users.bunny
  }
}

resource "google_kms_crypto_key_iam_policy" "state" {
  crypto_key_id = google_kms_crypto_key.state.id
  policy_data   = data.google_iam_policy.kms_state.policy_data

  lifecycle {
    prevent_destroy = true
    destroy         = false
  }
}

resource "google_kms_crypto_key_iam_policy" "bunny" {
  crypto_key_id = google_kms_crypto_key.bunny.id
  policy_data   = data.google_iam_policy.kms_bunny.policy_data

  lifecycle {
    prevent_destroy = true
    destroy         = false
  }
}
