# Which build each service runs in dev. Every apply converges on this file.
#   "main"      newest CI build from main (repo apps)
#   "snapshot"  newest development build (repo apps-scratch): unmerged code,
#               built on a local developer machine or by snapshot-images.yml
#   "…@sha256:…" hold the service on this exact build
#   (absent)    Google's placeholder hello image
# Try a build for one apply only: -var 'image_overrides={"api-public-read"="snapshot"}'
#
# web: add "web" = "main" once Release Images has pushed its first build to
# apps (the merge of task 0.4). Until then "main" can't resolve and the plan
# fails, so web runs the placeholder.
images = {
  "api-public-read" = "main"
}
