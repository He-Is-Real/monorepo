#!/usr/bin/env bash
# Terraform external data source: the tag for a service's pruned build
# (tools/scripts/image-tag.sh, the same script CI uses) and whether that tag is
# still in the registry (cleanup policies delete old snapshots).
#
# stdin:  {"service": "api-read", "repository": "<host>/<project>/<repo>"}
# stdout: {"tag": "<12 hex>", "exists": "true" | "false"}
set -euo pipefail
query="$(cat)"
service="$(jq -r .service <<<"$query")"
repository="$(jq -r .repository <<<"$query")"
cd "$(dirname "$0")/../../../../.."
tag="$(tools/scripts/image-tag.sh "$service")"
if err="$(gcloud artifacts docker images describe "$repository/$service:$tag" --quiet --format='value(image_summary.digest)' 2>&1 >/dev/null)"; then
  exists=true
elif grep -q 'Image not found' <<<"$err"; then
  exists=false
else
  echo "$err" >&2
  exit 1
fi
jq -n --arg tag "$tag" --arg exists "$exists" '{tag: $tag, exists: $exists}'
