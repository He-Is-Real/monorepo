# The media worker's own identity (W1-A; Joel, 2026-11-08, worker-and-gcloud-sign-in.html): only
# certificates naming an allowed machine get a Google token, each machine may act as media-worker
# and nothing else, only cert-signer may sign with the authority's KMS key, and only the worker
# may call cert-signer. Before the authority's certificate exists, only the key is made. Mock
# providers.

mock_provider "google" {
  mock_resource "google_service_account" {
    defaults = {
      email  = "mock-account@heisreal-dev.iam.gserviceaccount.com"
      name   = "projects/heisreal-dev/serviceAccounts/mock-account@heisreal-dev.iam.gserviceaccount.com"
      member = "serviceAccount:mock-account@heisreal-dev.iam.gserviceaccount.com"
    }
  }
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
  # The mock can't make IAM policy JSON; the assertion below checks the policy's input instead.
  mock_data "google_iam_policy" {
    defaults = { policy_data = "{\"bindings\":[]}" }
  }
}
mock_provider "random" {}

override_resource {
  target = google_service_account.media_worker
  values = {
    email  = "media-worker@heisreal-dev.iam.gserviceaccount.com"
    name   = "projects/heisreal-dev/serviceAccounts/media-worker@heisreal-dev.iam.gserviceaccount.com"
    member = "serviceAccount:media-worker@heisreal-dev.iam.gserviceaccount.com"
  }
}
override_resource {
  target = google_service_account.cert_signer
  values = {
    email  = "cert-signer@heisreal-dev.iam.gserviceaccount.com"
    name   = "projects/heisreal-dev/serviceAccounts/cert-signer@heisreal-dev.iam.gserviceaccount.com"
    member = "serviceAccount:cert-signer@heisreal-dev.iam.gserviceaccount.com"
  }
}
override_resource {
  target = google_iam_workload_identity_pool.workers
  values = {
    name = "projects/123456789012/locations/global/workloadIdentityPools/workers"
  }
}
override_resource {
  target = google_kms_crypto_key.worker_ca
  values = {
    id = "projects/heisreal-dev/locations/europe-west2/keyRings/worker-identity/cryptoKeys/worker-ca"
  }
}
override_resource {
  target = google_service_account.result_writer
  values = {
    email  = "workflow@heisreal-dev.iam.gserviceaccount.com"
    name   = "projects/heisreal-dev/serviceAccounts/workflow@heisreal-dev.iam.gserviceaccount.com"
    member = "serviceAccount:workflow@heisreal-dev.iam.gserviceaccount.com"
  }
}

variables {
  project_id               = "heisreal-dev"
  environment              = "dev"
  cluster_dns_domain       = "cluster.heisreal-dev.internal"
  ci_image_pusher_email    = "ci-image-pusher@heisreal-dev.iam.gserviceaccount.com"
  ci_snapshot_pusher_email = "ci-snapshot-pusher@heisreal-dev.iam.gserviceaccount.com"
  web_origins              = ["https://web-abc-nw.a.run.app"]
  clerk_issuer             = "https://example.clerk.accounts.dev"
  clerk_jwt_public_key     = "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n"
  api_public_read_media = {
    stream_library_id   = "789855"
    stream_cdn_hostname = "vz-example.b-cdn.net"
    images_cdn_hostname = "example-images.b-cdn.net"
  }
  media_ready = {
    worker_impersonators = ["user:joel@heisreal.today"]
  }
  worker_identity = {
    machines       = ["joel-pc", "church-1"]
    ca_certificate = "-----BEGIN CERTIFICATE-----\nMIIBtest==\n-----END CERTIFICATE-----\n"
  }
}

run "off_by_default" {
  command = plan
  variables {
    worker_identity = null
  }

  assert {
    condition = (
      length(google_kms_crypto_key.worker_ca) == 0 &&
      length(google_storage_bucket.worker_certificates) == 0 &&
      length(google_iam_workload_identity_pool.workers) == 0 &&
      length(google_cloud_run_v2_service.cert_signer) == 0 &&
      length(google_service_account_iam_member.media_worker_machines) == 0
    )
    error_message = "No authority, pool or signing service unless worker_identity is set."
  }
}

run "only_the_key_until_the_authority_certificate_exists" {
  command = plan
  variables {
    worker_identity = { machines = ["joel-pc"] }
  }

  assert {
    condition = (
      google_kms_key_ring.worker_identity[0].location == "europe-west2" &&
      google_kms_crypto_key.worker_ca[0].purpose == "ASYMMETRIC_SIGN" &&
      google_kms_crypto_key.worker_ca[0].version_template[0].algorithm == "EC_SIGN_P256_SHA256" &&
      length(google_iam_workload_identity_pool_provider.worker_ca) == 0 &&
      length(google_cloud_run_v2_service.cert_signer) == 0 &&
      length(google_service_account_iam_member.media_worker_machines) == 0
    )
    error_message = "Step 1 makes the London KMS key only: no trust, no service, no grants."
  }
}

run "only_allowed_machines_get_a_token" {
  command = apply

  assert {
    condition     = google_iam_workload_identity_pool_provider.worker_ca[0].attribute_condition == "assertion.subject.dn.cn in ['joel-pc', 'church-1']"
    error_message = "Google must refuse any certificate whose name isn't in machines."
  }
  assert {
    condition     = google_iam_workload_identity_pool_provider.worker_ca[0].attribute_mapping == tomap({ "google.subject" = "assertion.subject.dn.cn" })
    error_message = "The principal is the certificate's machine name."
  }
  assert {
    condition     = google_iam_workload_identity_pool_provider.worker_ca[0].x509[0].trust_store[0].trust_anchors[0].pem_certificate == var.worker_identity.ca_certificate
    error_message = "Google trusts exactly our authority's certificate."
  }
}

run "each_machine_acts_as_media_worker_only" {
  command = apply

  assert {
    condition = (
      length(google_service_account_iam_member.media_worker_machines) == 2 &&
      alltrue([for m in google_service_account_iam_member.media_worker_machines :
        m.role == "roles/iam.workloadIdentityUser" &&
        m.service_account_id == "projects/heisreal-dev/serviceAccounts/media-worker@heisreal-dev.iam.gserviceaccount.com"
      ]) &&
      google_service_account_iam_member.media_worker_machines["joel-pc"].member == "principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/workers/subject/joel-pc"
    )
    error_message = "Each listed machine (one principal per name) may act as media-worker, and nothing else."
  }
}

run "only_cert_signer_signs_and_only_the_worker_calls_it" {
  command = apply

  assert {
    condition = (
      length(data.google_iam_policy.worker_ca[0].binding) == 1 &&
      one(data.google_iam_policy.worker_ca[0].binding).role == "roles/cloudkms.signer" &&
      one(data.google_iam_policy.worker_ca[0].binding).members == toset(["serviceAccount:cert-signer@heisreal-dev.iam.gserviceaccount.com"])
    )
    error_message = "The authority's key: cert-signer may sign, nobody else is granted anything."
  }
  assert {
    condition = (
      google_cloud_run_v2_service_iam_member.cert_signer_worker[0].role == "roles/run.invoker" &&
      google_cloud_run_v2_service_iam_member.cert_signer_worker[0].member == "serviceAccount:media-worker@heisreal-dev.iam.gserviceaccount.com" &&
      google_cloud_run_v2_service.cert_signer[0].invoker_iam_disabled == false &&
      google_cloud_run_v2_service.cert_signer[0].location == "europe-west2"
    )
    error_message = "Only media-worker may call cert-signer (London)."
  }
  assert {
    condition = {
      for e in google_cloud_run_v2_service.cert_signer[0].template[0].containers[0].env : e.name => e.value
      } == {
      KMS_KEY_VERSION            = "projects/heisreal-dev/locations/europe-west2/keyRings/worker-identity/cryptoKeys/worker-ca/cryptoKeyVersions/1"
      CA_CERTIFICATE             = var.worker_identity.ca_certificate
      ALLOWED_MACHINES           = "joel-pc,church-1"
      CERTIFICATE_LIFETIME_HOURS = "24"
      CERTIFICATE_RECORDS_BUCKET = "heisreal-dev-worker-certificates"
    }
    error_message = "cert-signer gets the key, the authority's certificate, the same machine list, the lifetime (24 h by default) and its records bucket."
  }
}

run "newest_certificate_records_are_private_and_in_london" {
  command = apply

  assert {
    condition = (
      upper(google_storage_bucket.worker_certificates[0].location) == "EUROPE-WEST2" &&
      google_storage_bucket.worker_certificates[0].uniform_bucket_level_access == true &&
      google_storage_bucket.worker_certificates[0].public_access_prevention == "enforced" &&
      google_storage_bucket.worker_certificates[0].versioning[0].enabled == false
    )
    error_message = "The records bucket: London, uniform access, never public, no versions."
  }
  assert {
    condition = (
      length(data.google_iam_policy.worker_certificates[0].binding) == 1 &&
      one(data.google_iam_policy.worker_certificates[0].binding).role == "roles/storage.objectUser" &&
      one(data.google_iam_policy.worker_certificates[0].binding).members == toset(["serviceAccount:cert-signer@heisreal-dev.iam.gserviceaccount.com"])
    )
    error_message = "Only cert-signer may read and write the records (authoritative bucket policy)."
  }
}

run "the_last_machine_cancelled_refuses_everyone" {
  command = apply
  variables {
    worker_identity = {
      machines       = []
      ca_certificate = "-----BEGIN CERTIFICATE-----\nMIIBtest==\n-----END CERTIFICATE-----\n"
    }
  }

  assert {
    condition = (
      google_iam_workload_identity_pool_provider.worker_ca[0].attribute_condition == "assertion.subject.dn.cn in []" &&
      length(google_service_account_iam_member.media_worker_machines) == 0
    )
    error_message = "With no machines, Google must refuse every certificate and no principal may act as media-worker."
  }
  assert {
    # Set but empty: cert-signer starts and refuses everyone (absent would stop it).
    condition = one([
      for e in google_cloud_run_v2_service.cert_signer[0].template[0].containers[0].env : e.value if e.name == "ALLOWED_MACHINES"
    ]) == ""
    error_message = "cert-signer gets an empty machine list, not a missing one."
  }
}

run "refuses_bad_names" {
  command = plan
  variables {
    worker_identity = { machines = ["Joel PC"] }
  }
  expect_failures = [var.worker_identity]
}

run "refuses_a_lifetime_over_30_days" {
  command = plan
  variables {
    worker_identity = { machines = ["joel-pc"], certificate_lifetime_hours = 721 }
  }
  expect_failures = [var.worker_identity]
}

run "refuses_a_key_as_the_authority_certificate" {
  command = plan
  variables {
    worker_identity = { machines = ["joel-pc"], ca_certificate = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n" }
  }
  expect_failures = [var.worker_identity]
}
