# modules/org: organisation-wide UK settings (postponed)

**Not called by any root today** (D119, Joel, 2026-10-30). It holds two settings that cover
every project in `heisreal.today`, dev and prod alike:

- **D102:** an organisation policy, `constraints/gcp.resourceLocations` = `in:gb-locations`.
  Google Cloud then refuses to create a location-bound resource outside the UK, so a mistake
  fails at apply time instead of quietly putting data abroad.
- **D104:** the organisation's default log location, `europe-west2`. Every project created
  afterwards (prod included) gets its log buckets, Google's 400-day audit logs (`_Required`)
  among them, in London.

Both need organisation roles that only the organisation admin (`info@heisreal.today`) can grant,
once. That setup hasn't been done, and while `live/dev/bootstrap` called this module, nobody
could plan bootstrap without it. So the call was taken out; the module and its tests
(`tests/uk_only.tftest.hcl`, mock provider, run in CI by `infra/terraform/test-modules.sh`) stay
here, ready.

**What still keeps data in the UK:** every Google Cloud resource we create names `europe-west2`
in OpenTofu, and dev's own logs go to a London bucket (`modules/bootstrap/logging.tf`, D101).
What's missing is the organisation-wide safety net that refuses a mistake.

## Turning it back on (a gate before Go live, and before a prod project is created)

1. The organisation admin runs the one-time grants in `infra/terraform/README.md`, "Where data
   lives".
2. In `live/dev/bootstrap/main.tf`, replace the `removed { from = module.org }` block with the
   module call and the import of the log settings (both in git history:
   `git show 48f7023 -- infra/terraform/live/dev/bootstrap/main.tf`):

   ```hcl
   module "org" {
     source = "../../../modules/org"

     org_id               = "463617123121"
     allowed_locations    = ["in:gb-locations"]
     log_storage_location = "europe-west2"

     depends_on = [module.bootstrap]
   }

   import {
     to = module.org.google_logging_organization_settings.this
     id = "organizations/463617123121/settings"
   }
   ```

3. Plan and apply bootstrap locally (`tools/scripts/tf.sh bootstrap plan`, then `apply`).

Do this **before the prod project is created**: a project's `_Required` bucket takes the default
log location at creation and can never move afterwards.
