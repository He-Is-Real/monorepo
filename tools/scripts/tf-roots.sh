#!/usr/bin/env bash
# Which OpenTofu roots a change touches, for PR plans only (tofu-plan.yml). tofu-apply.yml never
# selects: it plans every root on every run. Tests: tests/tf-roots.test.mjs.
#
#   tools/scripts/tf-roots.sh changed <base> <head>
#
# Prints one root per line in plan order (gcp images cluster bunny), then bootstrap (a notice
# only: it is planned and applied locally). Runs `git diff <base>...<head>` in the current
# repository, so both commits must be fetched.
# Exit codes: 64 usage, otherwise git's.
set -euo pipefail

if [ $# -ne 3 ] || [ "$1" != changed ]; then
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
fi

files="$(git diff --name-only "$2...$3")"

declare -A selected=()
tf=infra/terraform
while IFS= read -r file; do
  case "$file" in
  "$tf"/live/dev/gcp/* | "$tf"/modules/gcp/*) selected[gcp]=1 ;;
  # Clerk's public key: SurrealDB (cluster) and, through a link, api-user/api-admin (gcp) pin it.
  # gcp selects cluster below.
  "$tf"/live/dev/cluster/clerk.auto.tfvars) selected[gcp]=1 ;;
  "$tf"/live/dev/cluster/* | "$tf"/modules/cluster/* | "$tf"/modules/db-migration/* | \
    "$tf"/modules/db-identity/* | infra/k8s/surrealdb/* | libs/database/schema/* | libs/legal/dpa/* | \
    libs/legal/forms/*)
    selected[cluster]=1
    ;;
  "$tf"/live/dev/bunny/* | "$tf"/modules/bunny/* | "$tf"/modules/bunny-state-guard/*) selected[bunny]=1 ;;
  "$tf"/live/dev/images/* | tools/scripts/image-tag.sh) selected[images]=1 ;;
  "$tf"/live/dev/bootstrap/* | "$tf"/modules/bootstrap/* | "$tf"/modules/org/*) selected[bootstrap]=1 ;;
  tools/scripts/tf*.sh | .github/actions/tofu/* | .github/workflows/tofu-*.yml | mise.toml)
    selected[gcp]=1 selected[cluster]=1 selected[bunny]=1
    ;;
  esac
done <<< "$files"

# cluster reads gcp's outputs, so a gcp change can change the cluster plan.
[ -z "${selected[gcp]:-}" ] || selected[cluster]=1

for root in gcp images cluster bunny bootstrap; do
  [ -z "${selected[$root]:-}" ] || echo "$root"
done
