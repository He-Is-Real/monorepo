output "allowed_locations" {
  value = google_org_policy_policy.resource_locations.spec[0].rules[0].values[0].allowed_values
}

output "log_storage_location" {
  value = google_logging_organization_settings.this.storage_location
}
