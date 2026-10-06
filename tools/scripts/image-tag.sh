#!/usr/bin/env bash
# Prints the image tag for a service: a hash of its pruned build output
# (apps/<service>/dist, source maps excluded). Same code -> same tag, so a
# build whose tag already exists in the registry can be skipped.
# Also used by the local images root (infra/terraform/live/dev/images).
#
#   tools/scripts/image-tag.sh api-read   (after `pnpm nx run api-read:prune`)
set -euo pipefail
dist="apps/${1:?usage: image-tag.sh <service>}/dist"
cd "$dist"
find . -type f ! -name '*.map' | sed 's|^\./||' | LC_ALL=C sort |
  while IFS= read -r f; do sha1sum "$f" | cut -c1-40; done |
  tr -d '\n' | sha1sum | cut -c1-12
