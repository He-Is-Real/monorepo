# The media worker's own identity (W1-A; Joel, 2026-11-08,
# project/context/research/worker-and-gcloud-sign-in.html): the worker signs in to Google with a
# certificate from our own authority, never with a person's gcloud login and never with a Google
# key file. Google's workload identity federation trusts only that authority.
#
#   worker machine ── every 6 h: new key, renewal signed with the current key ──▶ cert-signer
#   cert-signer (Cloud Run, only media-worker may call it) ── newest for this machine? (bucket)
#               ── KMS asymmetricSign ──▶ 24 h certificate, recorded as the machine's newest
#   worker ── mTLS with the certificate ──▶ Google's token service ──▶ 1 h token as media-worker
#
# The authority's key is a Cloud KMS key in London: it signs but can never be copied out, and only
# cert-signer's account is granted signing (developers reach it through roles/owner, for
# `worker-identity.sh enrol` and `ca`; tf-deployer manages the key's IAM, so it could grant itself
# signing: accepted, W2-3, Joel 2026-11-09). Google has no revocation list for these certificates, so
# short lifetimes are the safety net: a copied certificate stops working when it expires, and
# taking a name out of `machines` refuses it at once for new Google tokens and renewals.
#
# Order (worker_identity.ca_certificate starts null):
#   1. apply: the key ring and key (plus the media-worker grants that don't need the authority);
#   2. `tools/scripts/worker-identity.sh ca` writes live/<env>/gcp/worker-ca.pem; commit it;
#   3. apply: the pool, its provider, cert-signer and the per-machine grants;
#   4. on the worker machine: `tools/scripts/worker-identity.sh enrol <machine>`.

locals {
  worker_identity    = var.worker_identity != null
  worker_identity_on = local.worker_identity && try(var.worker_identity.ca_certificate != null, false)
  worker_machines    = local.worker_identity_on ? toset(var.worker_identity.machines) : toset([])
  # CEL: the certificate's subject CN must be one of the allowed machine names.
  worker_condition = local.worker_identity ? format(
    "assertion.subject.dn.cn in [%s]",
    join(", ", [for m in var.worker_identity.machines : "'${m}'"]),
  ) : ""
}

# --- The authority's key (KMS, London) -------------------------------------------------------------
# A key ring can't be deleted; the key mustn't be, or every certificate (and the trust store) dies.
resource "google_kms_key_ring" "worker_identity" {
  count = local.worker_identity ? 1 : 0

  project  = var.project_id
  name     = "worker-identity"
  location = var.region
}

resource "google_kms_crypto_key" "worker_ca" {
  count = local.worker_identity ? 1 : 0

  name     = "worker-ca"
  key_ring = google_kms_key_ring.worker_identity[0].id
  purpose  = "ASYMMETRIC_SIGN"
  labels   = merge(local.labels, { component = "worker-identity" })

  # P-256: what Google's X.509 federation accepts, and what tools/scripts/worker-identity.sh and
  # apps/cert-signer use (version 1).
  version_template {
    algorithm        = "EC_SIGN_P256_SHA256"
    protection_level = "SOFTWARE"
  }

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  worker_ca_key_version = local.worker_identity ? "${google_kms_crypto_key.worker_ca[0].id}/cryptoKeyVersions/1" : ""
}

# Authoritative on the key: cert-signer may sign, nobody else is granted anything on it.
resource "google_kms_crypto_key_iam_policy" "worker_ca" {
  count = local.worker_identity ? 1 : 0

  crypto_key_id = google_kms_crypto_key.worker_ca[0].id
  policy_data   = data.google_iam_policy.worker_ca[0].policy_data
}

data "google_iam_policy" "worker_ca" {
  count = local.worker_identity ? 1 : 0

  binding {
    role    = "roles/cloudkms.signer"
    members = [google_service_account.cert_signer[0].member]
  }
}

# --- Each machine's newest certificate (W2-1 A; Joel, 2026-11-09) ------------------------------------
# One small JSON object per machine (serial and expiry of the newest certificate issued for it):
# cert-signer renews only that certificate, so a copied certificate and key can't keep renewing.
# Not a database and no personal data. Overwritten in place, so no versions are kept.
resource "google_storage_bucket" "worker_certificates" {
  count = local.worker_identity ? 1 : 0

  project                     = var.project_id
  name                        = "${var.project_id}-worker-certificates"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = merge(local.labels, { component = "worker-identity" })

  versioning {
    enabled = false
  }
}

# Authoritative: only cert-signer may read and write the records (replacing the default project
# bindings). Developers reach them through their project-level storage.admin (bootstrap) for
# `worker-identity.sh enrol`, which overwrites a machine's record.
data "google_iam_policy" "worker_certificates" {
  count = local.worker_identity ? 1 : 0

  binding {
    role    = "roles/storage.objectUser"
    members = [google_service_account.cert_signer[0].member]
  }
}

resource "google_storage_bucket_iam_policy" "worker_certificates" {
  count = local.worker_identity ? 1 : 0

  bucket      = google_storage_bucket.worker_certificates[0].name
  policy_data = data.google_iam_policy.worker_certificates[0].policy_data
}

# --- The signing service (apps/cert-signer) ---------------------------------------------------------
resource "google_service_account" "cert_signer" {
  count = local.worker_identity ? 1 : 0

  project      = var.project_id
  account_id   = "cert-signer"
  display_name = "Cloud Run: cert-signer (signs the media worker's certificates with the KMS key)"
}

resource "google_cloud_run_v2_service" "cert_signer" {
  count = local.worker_identity_on ? 1 : 0

  project             = var.project_id
  name                = "cert-signer"
  location            = var.region
  deletion_protection = var.run_deletion_protection
  labels              = merge(local.labels, { component = "worker-identity" })

  # The worker is off Google Cloud, so it takes traffic from the internet; Cloud Run refuses any
  # request without a Google ID token of a run.invoker (media-worker only) before our code runs.
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = false

  template {
    service_account = google_service_account.cert_signer[0].email

    scaling {
      min_instance_count = 0
      max_instance_count = 1 # a renewal every few hours per machine; scale to zero
    }

    # No VPC access: it reaches only Cloud KMS and its records bucket (Google APIs), never the
    # database.

    containers {
      image = lookup(var.images, "cert-signer", "us-docker.pkg.dev/cloudrun/container/hello")

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
        cpu_idle = true
      }

      env {
        name  = "KMS_KEY_VERSION"
        value = local.worker_ca_key_version
      }
      # Public: the authority's certificate (no key).
      env {
        name  = "CA_CERTIFICATE"
        value = var.worker_identity.ca_certificate
      }
      # The same list as the provider's condition below.
      env {
        name  = "ALLOWED_MACHINES"
        value = join(",", var.worker_identity.machines)
      }
      env {
        name  = "CERTIFICATE_LIFETIME_HOURS"
        value = tostring(var.worker_identity.certificate_lifetime_hours)
      }
      env {
        name  = "CERTIFICATE_RECORDS_BUCKET"
        value = google_storage_bucket.worker_certificates[0].name
      }

      startup_probe {
        tcp_socket {
          port = 8080
        }
        period_seconds    = 5
        failure_threshold = 6
      }
    }
  }

  depends_on = [
    google_kms_crypto_key_iam_policy.worker_ca,
    google_storage_bucket_iam_policy.worker_certificates,
  ]
}

# Only the worker may ask for a certificate; it must also prove a current one (the route checks).
resource "google_cloud_run_v2_service_iam_member" "cert_signer_worker" {
  count = local.worker_identity_on ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.cert_signer[0].name
  role     = "roles/run.invoker"
  member   = google_service_account.media_worker[0].member
}

# --- Google trusts our authority --------------------------------------------------------------------
# Pools and providers are global IAM configuration (no data; tf-location-check.sh lists them).
resource "google_iam_workload_identity_pool" "workers" {
  count = local.worker_identity_on ? 1 : 0

  project                   = var.project_id
  workload_identity_pool_id = "workers"
  display_name              = "Workers off Google Cloud"
  description               = "Machines with a certificate from our worker authority (KMS key worker-ca)."
}

resource "google_iam_workload_identity_pool_provider" "worker_ca" {
  count = local.worker_identity_on ? 1 : 0

  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.workers[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "worker-ca"
  display_name                       = "Worker certificates"

  # The machine is the certificate's subject CN; only listed names get a Google token at all.
  attribute_mapping = {
    "google.subject" = "assertion.subject.dn.cn"
  }
  attribute_condition = local.worker_condition

  x509 {
    trust_store {
      trust_anchors {
        pem_certificate = var.worker_identity.ca_certificate
      }
    }
  }
}

# Each allowed machine may act as media-worker, and as nothing else (getAccessToken and
# getOpenIdToken on this one account).
resource "google_service_account_iam_member" "media_worker_machines" {
  for_each = local.worker_machines

  service_account_id = google_service_account.media_worker[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.workers[0].name}/subject/${each.value}"
}

# --- What the dashboard counts (monitoring.tf) ------------------------------------------------------
# cert-signer logs one JSON line per renewal: issued (with the machine), or refused / failed (with
# the reason). Names and reasons only, never a certificate.
resource "google_logging_metric" "worker_certificates" {
  for_each = local.worker_identity_on ? {
    issued = {
      description = "Worker certificates cert-signer issued, by machine."
      steps       = ["certificate_issued"]
      label       = "machine"
    }
    refused = {
      description = "Worker certificate renewals cert-signer refused or couldn't sign, by reason."
      steps       = ["certificate_refused", "certificate_sign_failed"]
      label       = "reason"
    }
  } : {}

  project     = var.project_id
  name        = "${local.name}/worker-certificates-${each.key}"
  description = each.value.description
  filter = join(" AND ", [
    "resource.type=\"cloud_run_revision\"",
    "resource.labels.service_name=\"cert-signer\"",
    "(${join(" OR ", [for s in each.value.steps : "jsonPayload.step=\"${s}\""])})",
  ])

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = each.value.label
      value_type = "STRING"
    }
  }
  label_extractors = {
    (each.value.label) = each.key == "issued" ? "EXTRACT(jsonPayload.machine)" : "EXTRACT(jsonPayload.reason)"
  }
}
