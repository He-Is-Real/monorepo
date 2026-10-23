#!/usr/bin/env bash
# One OpenTofu entry point for CI and laptops (D54).
#
#   tools/scripts/tf.sh <root> <tofu args...>       tofu -chdir=infra/terraform/live/dev/<root> ...
#   tools/scripts/tf.sh <root> plan-summary <plan>  changed addresses, actions and a count only
#   tools/scripts/tf.sh bunny-cli <args...>         the bunny CLI with the account key, one process
#   tools/scripts/tf.sh bunny-mask secrets|state    CI only: ::add-mask:: every Bunny key
#
# Roots: bootstrap|gcp|images|cluster|bunny.
#
# Identity (TF_SH_IDENTITY: unset, `self`, or a service-account email):
#   - an explicit TF_SH_IDENTITY wins (bootstrap accepts only `self`);
#   - otherwise, in GitHub Actions, the job's ambient credentials;
#   - otherwise the root's CI identity: gcp, images, cluster as tf-deployer; bunny as tf-bunny;
#     bootstrap always with your own credentials.
# Impersonation needs `gcloud auth login --update-adc` and Token Creator on the account.
#
# Refuses debug logs (TF_LOG*, RUNNER_DEBUG=1): they can print secrets into public CI logs.
# Always unsets TF_ENCRYPTION, which would replace the encryption config in code.
# For bunny, refuses `state pull`, `show -json` and `output -json`: use plan-summary.
#
# Exit codes: 64 usage, 1 refusal, otherwise tofu's.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
project=heisreal-dev
roots='bootstrap|gcp|images|cluster|bunny'
deployer="tf-deployer@${project}.iam.gserviceaccount.com"
tf_bunny="tf-bunny@${project}.iam.gserviceaccount.com"

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
}
die() {
  echo "tf.sh: $*" >&2
  exit 1
}
usage_error() {
  echo "tf.sh: $*" >&2
  exit 64
}

[ $# -ge 1 ] || usage
case "$1" in -h | --help) usage ;; esac

target="$1"
shift
case "$target" in
bootstrap | gcp | images | cluster | bunny) root="$target" ;;
bunny-cli | bunny-mask) root=bunny ;;
*) usage_error "unknown root '$target' (expected $roots, bunny-cli or bunny-mask)" ;;
esac
[ $# -ge 1 ] || usage

# Debug logs: provider logs include API responses, Bunny keys and Secret Manager payloads.
for var in TF_LOG TF_LOG_CORE TF_LOG_PROVIDER TF_LOG_PATH; do
  [ -z "${!var:-}" ] ||
    die "$var is set: debug logs can print secrets into public CI logs; run tofu directly for debugging (never for bunny)"
done
[ "${RUNNER_DEBUG:-}" != 1 ] ||
  die "RUNNER_DEBUG=1: debug logs can print secrets into public CI logs; run tofu directly for debugging (never for bunny)"

# The encryption config lives in code; TF_ENCRYPTION would replace it (spike S8).
unset TF_ENCRYPTION

# Who to run as: an email, or empty for the caller's own (or CI's ambient) credentials.
identity="${TF_SH_IDENTITY:-}"
if [ -n "$identity" ]; then
  if [ "$identity" = self ]; then
    identity=''
  elif ! [[ "$identity" =~ ^[a-z][a-z0-9-]*@[a-z][a-z0-9-]*\.iam\.gserviceaccount\.com$ ]]; then
    usage_error "TF_SH_IDENTITY must be 'self' or a service-account email, not '$identity'"
  elif [ "$root" = bootstrap ]; then
    die "bootstrap runs with your own credentials (TF_SH_IDENTITY=self or unset)"
  fi
elif [ "${GITHUB_ACTIONS:-}" = true ]; then
  identity=''
else
  case "$root" in
  bootstrap) identity='' ;;
  bunny) identity="$tf_bunny" ;;
  *) identity="$deployer" ;;
  esac
fi

# The backend variable would win over GOOGLE_IMPERSONATE_SERVICE_ACCOUNT (spike S4).
unset GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT
if [ -n "$identity" ]; then
  # tofu (gcs backend, gcp_kms, google provider) and gcloud (e.g. image-state.sh) respectively.
  export GOOGLE_IMPERSONATE_SERVICE_ACCOUNT="$identity"
  export CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT="$identity"
else
  unset GOOGLE_IMPERSONATE_SERVICE_ACCOUNT CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT
fi

# gcloud call with the chosen identity as an explicit flag.
gcloud_as() {
  if [ -n "$identity" ]; then
    gcloud "$@" --project="$project" --impersonate-service-account="$identity" --quiet
  else
    gcloud "$@" --project="$project" --quiet
  fi
}

if [ "$target" = bunny-cli ]; then
  command -v bunny > /dev/null || die "the bunny CLI isn't installed (npm install -g @bunny.net/cli)"
  [ -z "$identity" ] || echo "tf.sh: bunny-cli as $identity" >&2
  key="$(gcloud_as secrets versions access latest --secret=bunny-account-api-key 2> /dev/null)" ||
    die "couldn't read bunny-account-api-key (gcloud auth login, and Token Creator on ${identity:-nobody}?)"
  [ -n "$key" ] || die "bunny-account-api-key is empty (runbook: infra/terraform/README.md, Bunny.net)"
  BUNNYNET_API_KEY="$key" exec bunny "$@"
fi

dir="$repo/infra/terraform/live/dev/$root"

# Same OpenTofu everywhere: mise.toml is the pin.
expected="$(sed -n 's/^opentofu = "\(.*\)"/\1/p' "$repo/mise.toml")"
[ -n "$expected" ] || die "no opentofu pin in mise.toml"
found="$(tofu version -json 2> /dev/null | jq -r '.terraform_version' 2> /dev/null)" || found=''
[ "$found" = "$expected" ] || die "tofu ${found:-not found}, expected $expected (mise install)"

if [ "$target" = bunny-mask ]; then
  # Prints nothing but ::add-mask:: lines; any failure prints only the failed step.
  [ "${GITHUB_ACTIONS:-}" = true ] || die "bunny-mask runs only in GitHub Actions"
  [ $# -eq 1 ] || usage_error "bunny-mask secrets|state"
  mask() { # every non-empty line of stdin
    local line
    while IFS= read -r line || [ -n "$line" ]; do
      [ -z "$line" ] || printf '::add-mask::%s\n' "$line"
    done
  }
  fail() {
    echo "bunny-mask: failed ($1)" >&2
    exit 1
  }
  case "$1" in
  secrets)
    names="$(gcloud_as secrets list --format='value(name.basename())' 2> /dev/null)" || fail secrets
    while IFS= read -r name; do
      case "$name" in bunny-*) ;; *) continue ;; esac
      value="$(gcloud_as secrets versions access latest --secret="$name" 2> /dev/null)" || fail secrets
      mask <<< "$value"
    done <<< "$names"
    ;;
  state)
    # The five sensitive Bunny attributes (spike S11), plus the Stream pull zone's token_auth_key
    # from data.bunnynet_pullzone (same type, resources and data sources alike; D52). No state
    # yet: no values, no output.
    json="$(tofu -chdir="$dir" show -json 2> /dev/null)" || fail state
    values="$(jq -r '
      {
        bunnynet_stream_library: ["api_key", "api_key_readonly"],
        bunnynet_storage_zone: ["password", "password_readonly"],
        bunnynet_pullzone: ["token_auth_key"]
      } as $keys
      | (.values.root_module // {}) | recurse(.child_modules[]?) | .resources[]?
      | . as $r | ($keys[$r.type] // [])[] | $r.values[.] // empty | strings
    ' <<< "$json" 2> /dev/null)" || fail state
    mask <<< "$values"
    ;;
  *) usage_error "bunny-mask secrets|state" ;;
  esac
  exit 0
fi

if [ "${GITHUB_ACTIONS:-}" != true ]; then
  # Without the exported impersonation (gcloud honours it here too), so a failed impersonation
  # isn't reported as missing credentials.
  env -u CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT \
    gcloud auth application-default print-access-token > /dev/null 2>&1 ||
    die "no Application Default Credentials: gcloud auth login --update-adc"
  if [ -n "$identity" ]; then
    hint="you need Token Creator on it"
    [ "$root" != bunny ] || hint="tf-bunny exists only after bootstrap is applied (tf.sh bootstrap apply); $hint"
    env -u CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT gcloud auth application-default \
      print-access-token --impersonate-service-account="$identity" > /dev/null 2>&1 ||
      die "couldn't impersonate $identity: $hint, or run as yourself with TF_SH_IDENTITY=self"
  fi
fi
[ -z "$identity" ] || echo "tf.sh: $root as $identity" >&2

if [ "$1" = plan-summary ]; then
  # Allowlisted data only: never tofu's own output, which can hold sensitive values or errors
  # quoting them.
  [ $# -eq 2 ] || usage_error "$root plan-summary <planfile>"
  status=0
  json="$(tofu -chdir="$dir" show -json "$2" 2> /dev/null)" || status=$?
  if [ "$status" -ne 0 ]; then
    echo "plan-summary: could not read plan (exit $status)" >&2
    exit 1
  fi
  jq -r '
    [.resource_changes[]? | select(.change.actions != ["no-op"])
      | "\(.change.actions | join(",")) \(.address)"]
    | (.[]), "changes: \(length)"
  ' <<< "$json" 2> /dev/null || {
    echo "plan-summary: could not parse plan" >&2
    exit 1
  }
  exit 0
fi

if [ "$root" = bunny ]; then
  # These print the Bunny keys from state in clear text.
  refuse() { die "bunny: '$*' prints the Bunny keys; use 'tf.sh bunny plan-summary <plan>'"; }
  case "$1" in
  state) [ "${2:-}" != pull ] || refuse "$@" ;;
  show | output)
    for arg in "${@:2}"; do
      case "$arg" in -json | -raw) refuse "$@" ;; esac
    done
    ;;
  esac
fi

exec tofu -chdir="$dir" "$@"
