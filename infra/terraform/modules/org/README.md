# modules/org: organisation-wide UK settings

Called by one root only, `live/org` (Joel turned it on 2026-11-08, ending D119's postponement).
It holds settings that cover every project in `heisreal.today`, dev and prod alike:

- **D102:** an organisation policy, `constraints/gcp.resourceLocations` = `in:gb-locations`
  (Google's UK group). Google Cloud then refuses to create a location-bound resource outside the
  UK, so a mistake fails at apply time instead of quietly putting data abroad.
- **D104:** the organisation's default log location, `europe-west2`. Every project created
  afterwards (prod included) gets its log buckets, Google's 400-day audit logs (`_Required`)
  among them, in London.
- **`access.tf`:** what the people in `admins` need to set them: `roles/iam.organizationRoleAdmin`,
  the custom role `logSettingsAdmin` (only `logging.settings.get` and `.update`) and
  `roles/orgpolicy.policyAdmin` (adopted; it was granted by hand).

The first apply runs in three steps, and what the policy would refuse in dev (nothing today) is
listed in `infra/terraform/README.md`, "Organisation settings". Tests:
`tests/uk_only.tftest.hcl` (mock provider, run in CI by `infra/terraform/test-modules.sh`).

Apply it **before the prod project is created**: a project's `_Required` bucket takes the default
log location at creation and can never move afterwards.
