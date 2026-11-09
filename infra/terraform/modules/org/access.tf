# What the people who apply the org root need at organisation level, kept in OpenTofu rather than
# granted by hand. An organisation admin can grant roles but not read or set the log settings,
# set policies or create custom roles, so the first apply runs in three steps
# (infra/terraform/README.md, "Where data lives"): each step's grants must exist (and spread,
# about a minute) before the next step's plan or apply can use them.

# Step 1. Lets them create organisation custom roles (logSettingsAdmin below) and read them on
# every later plan.
resource "google_organization_iam_member" "role_admin" {
  for_each = toset(var.admins)

  org_id = var.org_id
  role   = "roles/iam.organizationRoleAdmin"
  member = each.value
}

# Step 2. Only the two log settings permissions: no access to log entries, sinks or buckets
# (roles/logging.configWriter would add org-wide sinks; roles/logging.admin every project's logs).
resource "google_organization_iam_custom_role" "log_settings_admin" {
  org_id      = var.org_id
  role_id     = "logSettingsAdmin"
  title       = "Log settings admin"
  description = "Reads and sets the organisation's default log location (modules/org)."
  permissions = ["logging.settings.get", "logging.settings.update"]

  depends_on = [google_organization_iam_member.role_admin]
}

resource "google_organization_iam_member" "log_settings_admin" {
  for_each = toset(var.admins)

  org_id = var.org_id
  role   = google_organization_iam_custom_role.log_settings_admin.name
  member = each.value
}

# Sets the location policy (custom roles can't hold orgpolicy.policy.set). Granted by hand before
# this root existed; the root adopts it with an import block.
resource "google_organization_iam_member" "policy_admin" {
  for_each = toset(var.admins)

  org_id = var.org_id
  role   = "roles/orgpolicy.policyAdmin"
  member = each.value
}
