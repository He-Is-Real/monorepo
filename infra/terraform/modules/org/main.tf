# Organisation-wide settings (heisreal.today): they apply to every project in the organisation,
# dev and prod alike, so exactly one root may call this module. No root calls it today: postponed
# until the organisation admin's one-time setup (D119; README.md here). Applied locally by a
# developer who holds roles/orgpolicy.policyAdmin and the custom role logSettingsAdmin on the
# organisation (infra/terraform/README.md, "Where data lives").

# D104: new projects' log buckets, Google's 400-day audit logs (`_Required`) included, are
# created in London. Existing buckets keep their location: Google fixes it at creation.
# Adopted with an import block in the live root. The provider sends every field on update, so
# the other two are declared as they are (no CMEK, _Default sink on) rather than left to reset.
# Destroying this resource only forgets it; Google keeps the setting.
resource "google_logging_organization_settings" "this" {
  organization         = var.org_id
  storage_location     = var.log_storage_location
  disable_default_sink = false # new projects keep their _Default sink
  kms_key_name         = ""    # no CMEK on new projects' log buckets
}

# D102: Google Cloud refuses to create a location-bound resource outside these locations, so a
# mistake fails at apply time instead of quietly creating something abroad. It checks new
# resources (including new VMs when GKE scales) and, for some services, updates.
resource "google_org_policy_policy" "resource_locations" {
  name   = "organizations/${var.org_id}/policies/gcp.resourceLocations"
  parent = "organizations/${var.org_id}"

  spec {
    rules {
      values {
        allowed_values = var.allowed_locations
      }
    }
  }

  lifecycle {
    # New projects' log buckets go to the default log location, so it must be allowed or
    # creating a project would fail.
    precondition {
      condition = anytrue([
        contains(var.allowed_locations, var.log_storage_location),
        contains(var.allowed_locations, "in:${var.log_storage_location}-locations"),
        # London, the only UK region today, is in Google's UK group.
        var.log_storage_location == "europe-west2" && contains(var.allowed_locations, "in:gb-locations"),
      ])
      error_message = "allowed_locations must include log_storage_location (${var.log_storage_location})."
    }
  }

  # Set after the default log location, which the policy must allow.
  depends_on = [google_logging_organization_settings.this]
}
