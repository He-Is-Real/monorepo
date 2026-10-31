# Which build each service runs in dev. Every apply converges on this file.
#   "main"      newest CI build from main (repo apps)
#   "snapshot"  newest development build (repo apps-scratch): unmerged code,
#               built on a local developer machine or by snapshot-images.yml
#   "…@sha256:…" hold the service on this exact build
#   (absent)    Google's placeholder hello image
# Try a build for one apply only: -var 'image_overrides={"api-public-read"="snapshot"}'
images = {
  "api-public-read" = "main"
  "api-user"        = "main"
  "api-admin"       = "main"
  "web"             = "main"
  "dev-seed"        = "main" # D49: the dev-seed Cloud Run Job (dev only)
  "housekeeping"    = "main" # the nightly housekeeping Cloud Run Job (#141)
}
