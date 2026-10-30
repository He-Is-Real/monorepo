# The legal documents of record, the privacy policy and the terms of use, every version kept
# forever: people agreed to a specific text, so it must stay readable. Two private London buckets:
#   - legal-documents: the cleaned PDF of each version (the server strips scripts and the like
#     from the upload), at legal/<document>/<versionId>/<sha256>.pdf, document privacy | terms.
#     This is the record: api-admin writes it, api-public-read streams it.
#   - legal-originals: the PDF exactly as uploaded, at originals/<document>/<versionId>/<sha256>.pdf,
#     kept for reference only. api-admin writes it; nothing reads or serves it.
# Nobody deletes or overwrites in either.

locals {
  # Both buckets are kept the same way; only the name differs.
  legal_buckets = {
    documents = "${var.project_id}-legal-documents"
    originals = "${var.project_id}-legal-originals"
  }
}

resource "google_storage_bucket" "legal" {
  for_each = local.legal_buckets

  project                     = var.project_id
  name                        = each.value
  location                    = "EUROPE-WEST2"
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels

  # No object versioning, on purpose: in a versioned bucket a retained live object can still be
  # made noncurrent (replaced at its path, its old bytes kept as an older generation), which
  # would leave a path pointing at a different PDF from the one recorded. Without versioning,
  # retention alone refuses every delete and overwrite of the live object.
  versioning {
    enabled = false
  }

  # 100 years, GCS's maximum: nobody, developers and project owners included, can delete or
  # overwrite an object before then. Unlocked, the policy itself can still be shortened or
  # removed (then objects could be deleted); locked, it can't (irreversible). Dev stays unlocked.
  retention_policy {
    retention_period = 3155760000
    is_locked        = var.legal_documents_retention_locked
  }
}

# Bucket-level grants only, and nothing else on either bucket. objectCreator can't delete, so it
# can't overwrite either (the app also writes with ifGenerationMatch=0); the retention policy
# stops deletes and overwrites for everyone, developers included.
resource "google_storage_bucket_iam_member" "legal_api_admin" {
  for_each = google_storage_bucket.legal

  bucket = each.value.name
  role   = "roles/storage.objectCreator"
  member = google_service_account.signed_in_api["api-admin"].member
}

# Only the cleaned copies are readable. The originals are never served, so api-public-read gets
# nothing on that bucket: an uploaded file may carry scripts we stripped from the record.
resource "google_storage_bucket_iam_member" "legal_documents_api_public_read" {
  bucket = google_storage_bucket.legal["documents"].name
  role   = "roles/storage.objectViewer"
  member = google_service_account.api_public_read.member
}

# Dev only: a placeholder privacy policy and terms of use from the repo, so dev has a document of
# record for each. The file's hash is in the name, so a changed file is a new object, never an
# overwrite.
locals {
  legal_dir = "${path.module}/../../../../libs/legal"
  dev_legal_placeholder_pdfs = var.dev_legal_placeholders ? {
    privacy = "${local.legal_dir}/dpa/dev_placeholder.pdf"
    terms   = "${local.legal_dir}/terms/dev_placeholder.pdf"
  } : {}
}

resource "google_storage_bucket_object" "dev_legal_placeholder" {
  for_each = local.dev_legal_placeholder_pdfs

  bucket       = google_storage_bucket.legal["documents"].name
  name         = "legal/${each.key}/dev_placeholder/${filesha256(each.value)}.pdf"
  source       = each.value
  content_type = "application/pdf"

  # A changed or removed file is forgotten, not deleted: retention refuses the delete, which
  # would fail the apply. The old version stays in the bucket, like every other.
  lifecycle {
    destroy = false
  }
}
