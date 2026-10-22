#!/usr/bin/env bash
# Checks the live Bunny access model (D57 C), read-only. Run after applying bootstrap, and after
# the bunny root once its state exists. No stage flag: it always checks the final model.
#
#   tools/scripts/check-bunny-fences.sh
#
# - As tf-deployer: still no route to anything Bunny's (secrets, dev/bunny/ state, the state
#   bucket's IAM, the tofu-bunny key), while its own secrets, buckets and state stay manageable.
# - As tf-bunny: exactly the bunny root's state, the `bunny-*` secrets and tofu-bunny; not other
#   roots' state, other secrets or tofu-state.
# - As you (org securityReviewer): nothing in the organisation's policy is public. The bunny
#   root's own never-public guard covers the project, bucket, keys and secrets.
#
# It impersonates each identity for 5 minutes (developers hold Token Creator on both) and only
# calls testIamPermissions, metadata reads and reads that must be refused; a secret it may read
# goes to /dev/null. Policy Troubleshooter can't check these: it doesn't fill in resource.type
# for the conditions, so it reports them as granted. Needs ADC (`gcloud auth login --update-adc`).
set -euo pipefail

project=heisreal-dev
org=463617123121
deployer="tf-deployer@${project}.iam.gserviceaccount.com"
bunny="tf-bunny@${project}.iam.gserviceaccount.com"
keys="https://cloudkms.googleapis.com/v1/projects/${project}/locations/europe-west2/keyRings/tofu/cryptoKeys"
objects="https://storage.googleapis.com/storage/v1/b/${project}-tfstate/o"
fail=0

token() { # token <service account>: a 5-minute access token
  local adc
  adc="$(gcloud auth application-default print-access-token)"
  curl -sf -X POST -H "Authorization: Bearer ${adc}" -H 'Content-Type: application/json' \
    -d '{"scope":["https://www.googleapis.com/auth/cloud-platform"],"lifetime":"300s"}' \
    "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/$1:generateAccessToken" |
    jq -r .accessToken
}

expect() { # expect <description> <wanted> <got>
  if [ "$2" = "$3" ]; then echo "ok    $1"; else
    echo "FAIL  $1: wanted $2, got $3"
    fail=1
  fi
}

test_perms() { # test_perms <url> <permission>...: those the current identity holds, sorted
  local url="$1" body
  shift
  body="$(jq -cn '{permissions: $ARGS.positional}' --args "$@")"
  curl -s -X POST "${auth[@]}" -H 'Content-Type: application/json' -d "$body" "$url" |
    jq -r '(.permissions // []) | sort | join(",")'
}

secret_perms() { # secret_perms <secret>: the management permissions held on it
  test_perms "https://secretmanager.googleapis.com/v1/projects/${project}/secrets/$1:testIamPermissions" \
    secretmanager.secrets.setIamPolicy secretmanager.secrets.update secretmanager.secrets.delete \
    secretmanager.versions.add secretmanager.versions.access
}

key_perms() { # key_perms <key>
  test_perms "${keys}/$1:testIamPermissions" \
    cloudkms.cryptoKeyVersions.useToDecrypt cloudkms.cryptoKeyVersions.useToEncrypt
}

bucket_perms() { # bucket_perms <bucket>
  curl -s "${auth[@]}" \
    "https://storage.googleapis.com/storage/v1/b/$1/iam/testPermissions?permissions=storage.buckets.setIamPolicy&permissions=storage.buckets.update" |
    jq -r '(.permissions // []) | sort | join(",")'
}

http() { curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$1"; }

# --- tf-deployer -------------------------------------------------------------
tok="$(token "$deployer")"
auth=(-H "Authorization: Bearer ${tok}")

# Ordinary secrets and buckets stay manageable (the gcp root needs that) ...
expect "deployer manages surreal-root-password" \
  "secretmanager.secrets.delete,secretmanager.secrets.setIamPolicy,secretmanager.secrets.update,secretmanager.versions.add" \
  "$(secret_perms surreal-root-password)"
expect "deployer manages heisreal-dev-db-backups" "storage.buckets.setIamPolicy,storage.buckets.update" \
  "$(bucket_perms heisreal-dev-db-backups)"
expect "deployer reads its own state (dev/gcp)" 200 "$(http "${objects}/dev%2Fgcp%2Fdefault.tfstate")"
expect "deployer uses tofu-state" \
  "cloudkms.cryptoKeyVersions.useToDecrypt,cloudkms.cryptoKeyVersions.useToEncrypt" "$(key_perms tofu-state)"

# ... but nothing Bunny's.
for s in bunny-account-api-key bunny-stream-api-key bunny-storage-password; do
  expect "deployer: no management of ${s}" "" "$(secret_perms "$s")"
  expect "deployer can't read ${s}" 403 \
    "$(http "https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${s}/versions/latest:access")"
done
expect "deployer: no IAM/update on the state bucket" "" "$(bucket_perms "${project}-tfstate")"
expect "deployer can't read dev/bunny state" 403 "$(http "${objects}/dev%2Fbunny%2Fdefault.tfstate?alt=media")"
expect "deployer can't use tofu-bunny" "" "$(key_perms tofu-bunny)"

# --- tf-bunny ----------------------------------------------------------------
tok="$(token "$bunny")"
auth=(-H "Authorization: Bearer ${tok}")

expect "tf-bunny sees dev/bunny state" 200 "$(http "${objects}/dev%2Fbunny%2Fdefault.tfstate")"
expect "tf-bunny can't see dev/gcp state" 403 "$(http "${objects}/dev%2Fgcp%2Fdefault.tfstate")"
expect "tf-bunny reads bunny-account-api-key" 200 \
  "$(http "https://secretmanager.googleapis.com/v1/projects/${project}/secrets/bunny-account-api-key/versions/latest:access")"
expect "tf-bunny can't read surreal-root-password" 403 \
  "$(http "https://secretmanager.googleapis.com/v1/projects/${project}/secrets/surreal-root-password/versions/latest:access")"
expect "tf-bunny uses tofu-bunny" \
  "cloudkms.cryptoKeyVersions.useToDecrypt,cloudkms.cryptoKeyVersions.useToEncrypt" "$(key_perms tofu-bunny)"
expect "tf-bunny can't use tofu-state" "" "$(key_perms tofu-state)"
expect "tf-bunny: no IAM/update on the state bucket" "" "$(bucket_perms "${project}-tfstate")"

unset tok auth

# --- organisation, as you ----------------------------------------------------
expect "nothing public in the organisation's policy" 0 \
  "$(gcloud organizations get-iam-policy "$org" --format=json |
    jq '[.bindings[]?.members[] | select(. == "allUsers" or . == "allAuthenticatedUsers")] | length')"

exit "$fail"
