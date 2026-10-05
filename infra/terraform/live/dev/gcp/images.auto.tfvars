# Which build each service runs in dev. Every apply converges on this file.
#   "main"      newest CI build from main (repo apps)
#   "snapshot"  newest development build (repo apps-scratch): unmerged code,
#               built on a local developer machine or by snapshot-images.yml
#   "…@sha256:…" hold the service on this exact build
# Try a build for one apply only: -var 'image_overrides={"api-read"="snapshot"}'
images = {
  "api-read" = "main"
}
