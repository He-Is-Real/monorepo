#!/usr/bin/env bash
# Builds and pushes the given services' images side by side, for _images.yml
# (tests: tests/image-push.test.mjs).
#
#   REPO=europe-west2-docker.pkg.dev/heisreal-dev/apps tools/scripts/image-push.sh <service>...
#
# Run after `nx run-many -t prune`, from the repository root, logged in to the registry, with a
# docker-container buildx builder. Each service's tag is the hash of its pruned build output
# (image-tag.sh): a tag that already exists is `unchanged`; otherwise the image is built from
# apps/<service>/dist and pushed (Docker layer cache in the Actions cache, one scope per
# service). All services build at once; each one's output is printed afterwards, in order.
# Prints one Markdown table row per service (image by digest, and pushed|unchanged|failed).
# Exits 1 if any build, push or digest lookup failed (the others still finish); 64 usage.
set -uo pipefail

if [ $# -eq 0 ] || [ -z "${REPO:-}" ]; then
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
fi
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# One service: writes "<state> <image@digest>" to $work/<service>.result; output to its log.
one() {
  local svc="$1" tag image state digest
  tag="$("$here/image-tag.sh" "$svc")" || return 1
  image="$REPO/$svc:$tag"
  if docker buildx imagetools inspect "$image" > /dev/null 2>&1; then
    state=unchanged
  else
    # No provenance/SBOM manifests: one registry version per build, so the cleanup policy's
    # keep_count counts builds.
    docker buildx build "apps/$svc/dist" --push --tag "$image" \
      --provenance=false --sbom=false \
      --label "org.opencontainers.image.revision=${GITHUB_SHA:-unknown}" \
      --label "org.opencontainers.image.source=${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}" \
      --cache-from "type=gha,version=2,scope=$svc" \
      --cache-to "type=gha,version=2,scope=$svc,mode=max" || return 1
    state=pushed
  fi
  # jq -e: a failed inspect must fail, not leave an empty digest in a green run.
  digest="$(docker buildx imagetools inspect "$image" --format '{{json .Manifest}}' | jq -er .digest)" &&
    [ -n "$digest" ] || { echo "No digest for $image"; return 1; }
  echo "$state $REPO/$svc@$digest" > "$work/$svc.result"
}

services=("$@") pids=()
for svc in "${services[@]}"; do
  one "$svc" > "$work/$svc.log" 2>&1 &
  pids+=("$!")
done

failed=0
for i in "${!pids[@]}"; do
  svc="${services[$i]}"
  if wait "${pids[$i]}"; then
    read -r state ref < "$work/$svc.result"
    echo "::group::$svc: $state" >&2
    cat "$work/$svc.log" >&2
    echo '::endgroup::' >&2
    echo "| \`$svc\` | \`$ref\` | $state |"
  else
    failed=1
    echo "::error::$svc: build, push or digest lookup failed" >&2
    cat "$work/$svc.log" >&2
    echo "| \`$svc\` | | failed |"
  fi
done
exit "$failed"
