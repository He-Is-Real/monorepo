#!/usr/bin/env bash
# Checks, as tf-deployer, that the bunny fences hold on the live policies (run after applying
# bootstrap, and after the bunny root once its state exists). Read-only: it impersonates
# tf-deployer for 5 minutes (developers hold Token Creator on it) and only calls
# testIamPermissions and object/secret reads that must be refused.
#
#   tools/scripts/check-bunny-fences.sh
#
# Policy Troubleshooter can't check these: it doesn't fill in resource.type for the
# conditions, so it reports them as granted. Needs ADC (`gcloud auth login --update-adc`).
set -euo pipefail

project=heisreal-dev
deployer="tf-deployer@${project}.iam.gserviceaccount.com"
fail=0

adc="$(gcloud auth application-default print-access-token)"
tok="$(curl -sf -X POST -H "Authorization: Bearer ${adc}" -H 'Content-Type: application/json' \
  -d '{"scope":["https://www.googleapis.com/auth/cloud-platform"],"lifetime":"300s"}' \
  "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${deployer}:generateAccessToken" |
  jq -r .accessToken)"
unset adc
auth=(-H "Authorization: Bearer ${tok}")

expect() { # expect <description> <wanted> <got>
  if [ "$2" = "$3" ]; then echo "ok    $1"; else
    echo "FAIL  $1: wanted $2, got $3"
    fail=1
  fi
}

secret_perms() { # secret_perms <secret>: the management permissions tf-deployer holds on it
  curl -s -X POST "${auth[@]}" -H 'Content-Type: application/json' \
    -d '{"permissions":["secretmanager.secrets.setIamPolicy","secretmanager.secrets.update","secretmanager.secrets.delete","secretmanager.versions.add","secretmanager.versions.access"]}' \
    "https://secretmanager.googleapis.com/v1/projects/${project}/secrets/$1:testIamPermissions" |
    jq -r '(.permissions // []) | sort | join(",")'
}

bucket_perms() { # bucket_perms <bucket>
  curl -s "${auth[@]}" \
    "https://storage.googleapis.com/storage/v1/b/$1/iam/testPermissions?permissions=storage.buckets.setIamPolicy&permissions=storage.buckets.update" |
    jq -r '(.permissions // []) | sort | join(",")'
}

http() { curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$1"; }

# Ordinary secrets and buckets stay manageable (the gcp root needs that) ...
expect "manages surreal-root-password" \
  "secretmanager.secrets.delete,secretmanager.secrets.setIamPolicy,secretmanager.secrets.update,secretmanager.versions.add" \
  "$(secret_perms surreal-root-password)"
expect "manages heisreal-dev-db-backups" "storage.buckets.setIamPolicy,storage.buckets.update" \
  "$(bucket_perms heisreal-dev-db-backups)"
expect "reads its own state (dev/gcp)" 200 \
  "$(http "https://storage.googleapis.com/storage/v1/b/${project}-tfstate/o/dev%2Fgcp%2Fdefault.tfstate")"

# ... but nothing Bunny's.
for s in bunny-account-api-key bunny-stream-api-key bunny-storage-password; do
  expect "no management of ${s}" "" "$(secret_perms "$s")"
  expect "can't read ${s}" 403 \
    "$(http "https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${s}/versions/latest:access")"
done
expect "no IAM/update on the state bucket" "" "$(bucket_perms "${project}-tfstate")"
expect "can't read dev/bunny state" 403 \
  "$(http "https://storage.googleapis.com/storage/v1/b/${project}-tfstate/o/dev%2Fbunny%2Fdefault.tfstate?alt=media")"

unset tok
exit "$fail"
