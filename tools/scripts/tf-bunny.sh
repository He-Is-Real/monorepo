#!/usr/bin/env bash
# Runs Terraform for the Bunny.net root (infra/terraform/live/dev/bunny), or the
# bunny CLI, without the Bunny account API key ever touching disk.
#
#   tools/scripts/tf-bunny.sh init | plan | apply | output ...  (any terraform command)
#   tools/scripts/tf-bunny.sh bunny api GET /videolibrary        (the bunny CLI)
#
# Terraform reads the key itself (an ephemeral Secret Manager read in the root,
# with your gcloud ADC login); this wrapper only refuses what would leak it or
# the keys in state: saved plans (-out) and Terraform debug logs (TF_LOG).
# For the bunny CLI, the key is read with gcloud into this process and handed
# to bunny as BUNNYNET_API_KEY for that one process: no .env file, no
# `bunny login` profile, nothing echoed. Needs gcloud logged in
# (`gcloud auth login --update-adc`) as a developer (project owner).
set -euo pipefail

project=heisreal-dev
secret=bunny-account-api-key
root="$(cd "$(dirname "$0")/../.." && pwd)/infra/terraform/live/dev/bunny"

die() {
  echo "tf-bunny.sh: $*" >&2
  exit 1
}

case "${1:-}" in
'' | -h | --help)
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
  ;;
bunny)
  shift
  command -v bunny > /dev/null || die "the bunny CLI isn't installed (npm install -g @bunny.net/cli)"
  key="$(gcloud secrets versions access latest --secret="$secret" --project="$project" --quiet)" ||
    die "couldn't read $secret (gcloud auth login --update-adc?)"
  [ -n "$key" ] || die "$secret is empty (runbook: infra/terraform/README.md, Bunny.net)"
  BUNNYNET_API_KEY="$key" exec bunny "$@"
  ;;
esac

for arg in "$@"; do
  case "$arg" in
  -out | -out=*) die "saved plans hold this root's Bunny keys in clear text: plan and apply without -out" ;;
  esac
done

# Provider debug logs would include the Secret Manager response and Bunny's API
# responses (keys included).
unset TF_LOG TF_LOG_CORE TF_LOG_PROVIDER TF_LOG_PATH

gcloud auth application-default print-access-token > /dev/null 2>&1 ||
  die "no Application Default Credentials: gcloud auth login --update-adc"

exec terraform -chdir="$root" "$@"
