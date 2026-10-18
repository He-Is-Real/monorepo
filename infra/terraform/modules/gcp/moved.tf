# D33/D36 rename: api-read -> api-public-read. These keep the state history,
# but the Cloud Run service name and the service account ID can't change in
# GCP, so the plan still replaces the service, its service account and their
# IAM bindings. Remove once every environment has applied them.

moved {
  from = google_service_account.api_read
  to   = google_service_account.api_public_read
}

moved {
  from = google_secret_manager_secret_iam_member.api_read
  to   = google_secret_manager_secret_iam_member.api_public_read
}

moved {
  from = google_cloud_run_v2_service.api_read
  to   = google_cloud_run_v2_service.api_public_read
}

moved {
  from = google_cloud_run_v2_service_iam_member.api_read_public
  to   = google_cloud_run_v2_service_iam_member.api_public_read_public
}

moved {
  from = google_cloud_run_v2_service_iam_member.api_read_invokers
  to   = google_cloud_run_v2_service_iam_member.api_public_read_invokers
}
