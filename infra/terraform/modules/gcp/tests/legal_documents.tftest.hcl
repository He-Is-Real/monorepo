# The privacy policy and terms of use of record: one private London bucket (the PDFs as the admins
# uploaded them) kept for 100 years, unlocked only in dev; api-admin may only create in it,
# api-public-read may only read it; dev gets a placeholder privacy policy and terms, named by
# their hash; api-admin and api-public-read get the bucket name, web gets api-admin's URL. Mock
# providers.

mock_provider "google" {
  mock_resource "google_service_account" {
    defaults = {
      email  = "mock-account@heisreal-dev.iam.gserviceaccount.com"
      name   = "projects/heisreal-dev/serviceAccounts/mock-account@heisreal-dev.iam.gserviceaccount.com"
      member = "serviceAccount:mock-account@heisreal-dev.iam.gserviceaccount.com"
    }
  }
}
mock_provider "random" {}

# Distinct identities, so the grants can be told apart.
override_resource {
  target = google_service_account.api_public_read
  values = {
    member = "serviceAccount:api-public-read@heisreal-dev.iam.gserviceaccount.com"
  }
}
override_resource {
  target = google_service_account.signed_in_api["api-admin"]
  values = {
    member = "serviceAccount:api-admin@heisreal-dev.iam.gserviceaccount.com"
  }
}

variables {
  project_id               = "heisreal-dev"
  environment              = "dev"
  cluster_dns_domain       = "cluster.heisreal-dev.internal"
  ci_image_pusher_email    = "ci-image-pusher@heisreal-dev.iam.gserviceaccount.com"
  ci_snapshot_pusher_email = "ci-snapshot-pusher@heisreal-dev.iam.gserviceaccount.com"
  web_origins              = ["https://web-abc-nw.a.run.app", "https://web-123.europe-west2.run.app"]
  clerk_issuer             = "https://example.clerk.accounts.dev"
  clerk_jwt_public_key     = <<-EOT
    -----BEGIN PUBLIC KEY-----
    MIIBIjAN
    4QIDAQAB
    -----END PUBLIC KEY-----
  EOT
}

run "private_london_bucket_kept_forever" {
  command = plan

  assert {
    condition = (
      google_storage_bucket.legal_documents.name == "heisreal-dev-legal-documents" &&
      google_storage_bucket.legal_documents.location == "EUROPE-WEST2" &&
      google_storage_bucket.legal_documents.uniform_bucket_level_access &&
      google_storage_bucket.legal_documents.public_access_prevention == "enforced" &&
      !google_storage_bucket.legal_documents.force_destroy &&
      !google_storage_bucket.legal_documents.versioning[0].enabled
    )
    error_message = "The bucket is in London, private, not versioned (retention alone keeps the live object) and not force-destroyable."
  }

  assert {
    condition = (
      google_storage_bucket.legal_documents.retention_policy[0].retention_period == "3155760000" &&
      !google_storage_bucket.legal_documents.retention_policy[0].is_locked
    )
    error_message = "100-year retention, unlocked in dev by default."
  }
}

run "admin_creates_public_read_reads_only_the_documents" {
  command = plan

  assert {
    condition = (
      google_storage_bucket_iam_member.legal_api_admin.bucket == "heisreal-dev-legal-documents" &&
      google_storage_bucket_iam_member.legal_api_admin.role == "roles/storage.objectCreator" &&
      google_storage_bucket_iam_member.legal_api_admin.member == "serviceAccount:api-admin@heisreal-dev.iam.gserviceaccount.com"
    )
    error_message = "api-admin may only create objects."
  }

  assert {
    condition = (
      google_storage_bucket_iam_member.legal_documents_api_public_read.bucket == "heisreal-dev-legal-documents" &&
      google_storage_bucket_iam_member.legal_documents_api_public_read.role == "roles/storage.objectViewer" &&
      google_storage_bucket_iam_member.legal_documents_api_public_read.member == "serviceAccount:api-public-read@heisreal-dev.iam.gserviceaccount.com"
    )
    error_message = "api-public-read may only read the documents of record."
  }
}

run "bucket_names_and_admin_url_reach_the_services" {
  command = plan

  # The service's uri is only known after apply, so the mock gives it a fixed value.
  override_resource {
    target = google_cloud_run_v2_service.signed_in_api["api-admin"]
    values = {
      uri = "https://api-admin-abc-nw.a.run.app"
    }
  }

  assert {
    condition = (
      one([for e in google_cloud_run_v2_service.api_public_read.template[0].containers[0].env :
      e.value if e.name == "LEGAL_DOCUMENTS_BUCKET"]) == "heisreal-dev-legal-documents" &&
      one([for e in google_cloud_run_v2_service.signed_in_api["api-admin"].template[0].containers[0].env :
      e.value if e.name == "LEGAL_DOCUMENTS_BUCKET"]) == "heisreal-dev-legal-documents"
    )
    error_message = "api-public-read and api-admin get LEGAL_DOCUMENTS_BUCKET."
  }

  assert {
    condition = length([for e in google_cloud_run_v2_service.signed_in_api["api-user"].template[0].containers[0].env :
    e if e.name == "LEGAL_DOCUMENTS_BUCKET"]) == 0
    error_message = "api-user doesn't get the legal bucket."
  }

  assert {
    condition = one([for e in google_cloud_run_v2_service.web.template[0].containers[0].env :
    e.value if e.name == "API_ADMIN_URL"]) == "https://api-admin-abc-nw.a.run.app"
    error_message = "web gets API_ADMIN_URL from the api-admin Cloud Run service."
  }
}

run "no_placeholders_by_default" {
  command = plan

  assert {
    condition     = length(google_storage_bucket_object.dev_legal_placeholder) == 0
    error_message = "No placeholder PDFs unless dev_legal_placeholders is set."
  }
}

run "dev_gets_a_placeholder_privacy_policy_and_terms" {
  command = plan
  variables {
    dev_legal_placeholders = true
  }

  assert {
    condition = (
      toset([for o in google_storage_bucket_object.dev_legal_placeholder : o.name]) == toset([
        "legal/privacy/dev_placeholder/${filesha256("../../../../libs/legal/dpa/dev_placeholder.pdf")}.pdf",
        "legal/terms/dev_placeholder/${filesha256("../../../../libs/legal/terms/dev_placeholder.pdf")}.pdf",
      ])
    )
    error_message = "Exactly two placeholders: legal/privacy/dev_placeholder/<sha256>.pdf and legal/terms/dev_placeholder/<sha256>.pdf."
  }

  assert {
    condition = alltrue([for o in google_storage_bucket_object.dev_legal_placeholder :
    o.content_type == "application/pdf" && o.bucket == "heisreal-dev-legal-documents"])
    error_message = "The placeholders are PDFs in the documents bucket."
  }
}

run "unlocked_retention_refused_outside_dev" {
  command = plan
  variables {
    environment = "prod"
  }
  expect_failures = [var.legal_documents_retention_locked]
}

run "locked_outside_dev" {
  command = plan
  variables {
    project_id                       = "heisreal-prod"
    environment                      = "prod"
    legal_documents_retention_locked = true
  }

  assert {
    condition     = google_storage_bucket.legal_documents.retention_policy[0].is_locked
    error_message = "The bucket's retention is locked when legal_documents_retention_locked is set."
  }
}

run "placeholders_refused_outside_dev" {
  command = plan
  variables {
    environment                      = "prod"
    legal_documents_retention_locked = true
    dev_legal_placeholders           = true
  }
  expect_failures = [var.dev_legal_placeholders]
}
