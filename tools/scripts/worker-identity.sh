#!/usr/bin/env bash
# The media worker's own identity (W1-A; docs/media-runbook.md, "Worker identity"): run by a
# developer with their own gcloud login. No key file is ever made outside the worker machine,
# and the authority's key never leaves Cloud KMS.
#
#   tools/scripts/worker-identity.sh enrol <machine>
#       On the worker machine: its first certificate, or a new one after it was off longer than
#       the certificate lifetime (24 hours by default). <machine> must be in worker_identity.machines
#       (infra/terraform/live/dev/gcp/main.tf), applied. Writes the identity directory
#       ($XDG_STATE_HOME/heisreal/worker-identity, 0700); from then on the worker renews it itself.
#
#   tools/scripts/worker-identity.sh ca [--replace]
#       Once: the authority's certificate, self-signed with the KMS key, written to
#       infra/terraform/live/dev/gcp/worker-ca.pem (public) for OpenTofu to trust. Commit it and
#       apply gcp. --replace makes a new one (every enrolled machine must enrol again).
#
# Needs: gcloud signed in (`gcloud auth login`), node and the repo's packages (`pnpm install`).
set -euo pipefail

project=heisreal-dev
region=europe-west2
# Kept in step with infra/terraform/modules/gcp/worker_identity.tf.
key_version="projects/$project/locations/$region/keyRings/worker-identity/cryptoKeys/worker-ca/cryptoKeyVersions/1"
pool=workers
provider=worker-ca
account="media-worker@$project.iam.gserviceaccount.com"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ca_file="$root/infra/terraform/live/dev/gcp/worker-ca.pem"
cli="$root/apps/media-worker/dist/identity.js"

die() {
  echo "worker-identity: $*" >&2
  exit 1
}
usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
}

[ $# -ge 1 ] || usage
command -v gcloud >/dev/null || die "gcloud isn't installed (docs/tooling-and-accounts.md)"
command -v node >/dev/null || die "node isn't installed (mise install)"
gcloud auth print-access-token >/dev/null 2>&1 ||
  die "your gcloud login isn't current: run 'gcloud auth login'"

build() {
  (cd "$root" && pnpm nx run media-worker:build --output-style=static >/dev/null) || die "the build failed"
}

case "$1" in
enrol)
  [ $# -eq 2 ] || usage
  machine="$2"
  [[ "$machine" =~ ^[a-z][a-z0-9-]{0,28}[a-z0-9]$ ]] ||
    die "'$machine' isn't a machine name (lower-case letters, digits and hyphens)"
  build
  number="$(gcloud projects describe "$project" --format='value(projectNumber)')" ||
    die "can't read the project number"
  # The signing service's settings (what OpenTofu deployed) go to the command on stdin.
  gcloud run services describe cert-signer --project "$project" --region "$region" --format=json |
    GCP_PROJECT="$project" GCP_PROJECT_NUMBER="$number" WORKLOAD_IDENTITY_POOL="$pool" \
      WORKLOAD_IDENTITY_PROVIDER="$provider" MEDIA_WORKER_ACCOUNT="$account" \
      node "$cli" enrol "$machine"
  ;;
ca)
  [ $# -eq 1 ] || [ "${2:-}" = --replace ] || usage
  if [ -e "$ca_file" ] && [ "${2:-}" != --replace ]; then
    die "$ca_file exists; --replace makes a new authority certificate (every machine then enrols again)"
  fi
  build
  KMS_KEY_VERSION="$key_version" CA_NAME="He Is Real $project worker authority" CA_YEARS=5 \
    node "$cli" ca "$ca_file"
  echo "worker-identity: commit $ca_file and apply gcp" >&2
  ;;
*) usage ;;
esac
