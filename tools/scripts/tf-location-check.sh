#!/usr/bin/env bash
# Reports, and outside dev refuses, a plan that would put something outside the UK (D119's
# interim guard until the organisation's location policy, D102, is set up at launch).
# Tests: tests/tf-location-check.test.mjs.
#
#   tofu show -json <plan> | tools/scripts/tf-location-check.sh <environment>
#
# `tf.sh <root> plan` runs it on every plan, CI's and laptops' alike, with the root's
# environment (`tf.sh <root> location-check <plan>` on a saved one). For every resource the plan
# creates or updates (replaces included), it reports:
#   - any `location`, `region` or `zone` attribute (any case, at any depth, list items included)
#     that isn't europe-west2, europe-west2-a/b/c or EUROPE-WEST2 (Cloud Storage's spelling),
#     including one known only after apply;
#   - a google_pubsub_topic whose message_storage_policy isn't exactly ["europe-west2"];
#   - a google_secret_manager_secret with automatic replication (global).
# Exceptions are the two lists below. CI logs are public: it prints only resource addresses,
# attribute paths and the offending locations ("(sensitive)" for a sensitive one), never other
# values.
#
# dev only warns (Joel, 2026-10-30: regional restrictions mustn't slow dev down); any other
# environment blocks. Exit codes: 0 all in the UK, or dev; 1 a finding or an unreadable plan
# outside dev; 64 usage.
set -euo pipefail

# Genuinely global: Google doesn't store data for them in a region, so they're never checked.
# Anything else that says `global` fails until it's listed here, with its reason.
global_types='{
  "google_project": "the project itself; what it holds is checked resource by resource",
  "google_project_service": "turns an API on; holds no data",
  "google_project_iam_member": "an access grant; IAM is global",
  "google_project_iam_member_remove": "removes an access grant; IAM is global",
  "google_project_iam_custom_role": "a role definition; IAM is global",
  "google_service_account": "an identity; IAM is global",
  "google_service_account_iam_member": "an access grant on an identity; IAM is global",
  "google_iam_workload_identity_pool": "CI sign-in config; IAM is global",
  "google_iam_workload_identity_pool_provider": "CI sign-in config; IAM is global",
  "google_billing_budget": "a budget and its alert rules; billing is global",
  "google_compute_network": "the VPC is global; its subnets are regional and checked",
  "google_compute_firewall": "VPC firewall rules are global and hold no data",
  "google_logging_project_sink": "routes logs; the bucket it writes to is checked",
  "google_cloud_quotas_quota_preference": "a quota setting; holds no data",
  "terraform_data": "OpenTofu-only, nothing at a provider"
}'

# Bunny names its own regions. UK is London (images). DE (Frankfurt) only for the Stream
# library's storage zone: Bunny sets Stream storage there and offers no other (D89). Zones are
# never replicated (copies elsewhere can never be removed again). bunnynet_dns_record.zone and
# bunnynet_storage_file.zone are a DNS zone and a storage zone, not places.
# shellcheck disable=SC2016 # a jq program: its $names are jq's
program='
def uk: . == "europe-west2" or . == "EUROPE-WEST2" or test("^europe-west2-[abc]$");
def is_loc_key: type == "string" and (ascii_downcase | IN("location", "region", "zone"));
# The attribute a leaf belongs to: its key, or the list it is an item of.
def leaf_key: if (.[-1] | type) == "number" then .[-2] else .[-1] end;
def show_path: map(if type == "number" then "[\(.)]" else ".\(.)" end) | join("") | ltrimstr(".");
def sensitive($s; $p): any(range(0; ($p | length) + 1) as $i | (try ($s | getpath($p[:$i])) catch null); . == true);
def bunny_ok($rc; $key; $v):
  ($rc.type == "bunnynet_storage_zone" and ($key | ascii_downcase) == "region" and
    ($v == "UK" or ($v == "DE" and ($rc.address | test("(^|\\.)bunnynet_storage_zone\\.stream(\\[[0-9]+\\])?$")))))
  or (($rc.type == "bunnynet_dns_record" or $rc.type == "bunnynet_storage_file") and ($key | ascii_downcase) == "zone");

[.resource_changes[]?
  | select(.mode == "managed" and (.change.actions | any(. == "create" or . == "update")))
  | select($global[.type] == null)
] as $changed
| [$changed[] | . as $rc
  | (.change.after // {}) as $after
  | (.change.after_sensitive // {}) as $sens
  | (
      ($after | paths(type == "string") | select(leaf_key | is_loc_key)) as $p
      | ($after | getpath($p)) as $v
      | select(bunny_ok($rc; $p | leaf_key; $v) | not)
      | if ($v | uk) then empty
        elif sensitive($sens; $p) then "\($rc.address): \($p | show_path)=(sensitive)"
        else "\($rc.address): \($p | show_path)=\($v)" end
    ),
    (
      (.change.after_unknown // {}) | paths(. == true) | select(leaf_key | is_loc_key)
      | "\($rc.address): \(show_path)=(known after apply)"
    ),
    (
      select($rc.type == "google_pubsub_topic")
      | ($after.message_storage_policy // []) as $m
      | select(($m | length) != 1 or $m[0].allowed_persistence_regions != ["europe-west2"])
      | "\($rc.address): message_storage_policy.allowed_persistence_regions=\(
          $m[0].allowed_persistence_regions // [] | if length == 0 then "(not declared)" else join(",") end)"
    ),
    (
      select($rc.type == "google_secret_manager_secret")
      | select(($after.replication[0].auto // []) | length > 0)
      | "\($rc.address): replication.auto=global"
    ),
    (
      select($rc.type == "bunnynet_storage_zone")
      | select(($after.replication_regions // []) | length > 0)
      | "\($rc.address): replication_regions=\($after.replication_regions | join(","))"
    )
  ] as $bad
| ($changed | length), $bad[]
'

[ $# -eq 1 ] && [ -n "$1" ] || {
  sed -n '6p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
}
environment="$1"

# Outside dev: the failure line and exit 1. In dev: a warning, and the plan goes on.
finish() { # finish <problem> <failure line>
  if [ "$environment" = dev ]; then
    echo "location-check: WARNING: $1 (dev: reported only; outside dev this fails the plan)"
    exit 0
  fi
  echo "location-check: $2"
  exit 1
}

# jq's own errors could quote the plan, so they're never shown.
report="$(jq -r --argjson global "$global_types" "$program" 2> /dev/null)" ||
  finish 'could not parse plan' 'could not parse plan'

changed="$(head -n 1 <<< "$report")"
bad="$(tail -n +2 <<< "$report")"
if [ -z "$bad" ]; then
  echo "location-check: ok ($changed created or updated)"
  exit 0
fi
while IFS= read -r line; do echo "location-check: $line"; done <<< "$bad"
count="$(wc -l <<< "$bad" | tr -d ' ')"
finish "$count outside the UK" \
  "$count outside the UK; fix them, or record an exception in tools/scripts/tf-location-check.sh"
