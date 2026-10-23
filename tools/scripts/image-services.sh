#!/usr/bin/env bash
# Prints the image services from image-services.txt on one line, space-separated.
#
#   pnpm nx run-many -t prune -p $(tools/scripts/image-services.sh)
set -euo pipefail
grep -v -e '^#' -e '^[[:space:]]*$' "$(dirname "$0")/image-services.txt" | tr '\n' ' ' | sed 's/ $/\n/'
