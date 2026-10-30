#!/usr/bin/env bash
# Reports, and outside dev refuses, a plan that would put something outside the UK (D119's
# interim guard until the organisation's location policy, D102, is set up at launch).
# Tests: tests/tf-location-check.test.mjs.
#
#   tofu show -json <plan> | tools/scripts/tf-location-check.sh <environment> [<schema>]
#
# <schema> is the root's `tofu providers schema -json`, which tells the check what an unknown
# value may hold (below); without it, any unknown value on a google_* resource is a finding.
# `tf.sh <root> plan` runs it on every plan, CI's and laptops' alike, with the root's
# environment (`tf.sh <root> location-check <plan>` on a saved one). For every resource the plan
# creates or updates (replaces included), it reports:
#   - any location attribute (any case, at any depth, list items included) that isn't
#     europe-west2, europe-west2-a/b/c or EUROPE-WEST2 (Cloud Storage's spelling), including one
#     known only after apply, or a container of them (Secret Manager replicas, Pub/Sub storage
#     policy, Bunny replication) known only after apply. Compute's links to a zone or region
#     (.../zones/<zone>, .../regions/<region>) count as their last part. A location attribute is `location`,
#     `region` or `zone`; on google_* resources also any name ending in one of them, plural or
#     with `_id` (location_id, node_locations, data_locations, storage_location, replica_zones,
#     ...), except the names in not_places below;
#   - on google_* resources, any value known only after apply (a dynamic block, a computed
#     object) whose schema holds a location attribute anywhere inside it, or that the schema
#     doesn't describe. This follows the provider's schema rather than a list of paths, so a new
#     resource or block is covered from day one. derived_when_unknown below lists the unknown
#     values (and everything inside them) Google can only derive from a location that is checked;
#   - a google_spanner_instance whose config isn't regional-europe-west2;
#   - a google_pubsub_topic whose message_storage_policy isn't exactly ["europe-west2"];
#   - a google_secret_manager_secret with automatic replication (global), or one that may get it
#     (replication[*].auto known only after apply).
# Exceptions are the lists below. CI logs are public: it prints only resource addresses,
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

# Google attribute names that look like locations but aren't places, have their own rule below
# (Pub/Sub's), or only repeat a location that is checked elsewhere (so being unknown until apply
# says nothing new). Anything ending in time_zone is a time zone, not a place.
not_places='[
  "managed_zone", "dataplex_zone", "request_location", "http_element_location",
  "source_location", "temp_location", "temp_gcs_location", "manifest_location",
  "disallowed_regions", "allowed_persistence_regions",
  "current_location_id", "effective_location", "membership_location",
  "supported_clone_regions", "disaster_recovery_supported_locations"
]'

# Values Google derives from a location that is checked, so being unknown until apply hides
# nothing: by resource type, the attribute path without list indexes. Everything inside a listed
# value is exempt too, and an unknown value holding one (a whole cluster_autoscaling block) is a
# finding only if it holds another location. Known values are still checked like any other.
derived_when_unknown='{
  "google_container_cluster": {
    "node_locations": "GKE only takes zones inside the cluster location, which is checked",
    "node_pool": "node pools run in zones inside the cluster location, which is checked",
    "cluster_autoscaling.auto_provisioning_locations": "zones inside the cluster location, which is checked"
  },
  "google_sql_database_instance": {
    "settings.location_preference": "Cloud SQL picks the zones inside the instance region, which is checked"
  }
}'

# Bunny names its own regions. UK is London (images). DE (Frankfurt) only for the Stream
# library's storage zone: Bunny sets Stream storage there and offers no other (D89). Zones are
# never replicated (copies elsewhere can never be removed again). bunnynet_dns_record.zone and
# bunnynet_storage_file.zone are a DNS zone and a storage zone, not places.
# shellcheck disable=SC2016 # a jq program: its $names are jq's
program='
# A Compute link to a zone or region (https://www.googleapis.com/compute/v1/projects/p/zones/z,
# projects/p/regions/r, zones/z) counts as its zone or region.
def place: (capture("^(https://(www|compute)\\.googleapis\\.com/compute/[a-z0-9]+/)?(projects/[^/]+/)?(zones|regions)/(?<p>[^/]+)$").p) // .;
def uk: place | . == "europe-west2" or . == "EUROPE-WEST2" or test("^europe-west2-[abc]$");
# A location attribute of resource $rc (see the header).
def is_loc_key($rc): type == "string" and (ascii_downcase as $k
  | if ($rc.type | startswith("google_")) then
      ($k | test("^([a-z0-9]+_)*(location|region|zone)s?(_id)?$"))
      and ($k | test("time_zone$") | not) and ($not_places | index($k) | not)
    else $k | IN("location", "region", "zone") end);
# The attribute a leaf belongs to: its key, or the list it is an item of.
def leaf_key: if (.[-1] | type) == "number" then .[-2] else .[-1] end;
def show_path: map(if type == "number" then "[\(.)]" else ".\(.)" end) | join("") | ltrimstr(".");
def sensitive($s; $p): any(range(0; ($p | length) + 1) as $i | (try ($s | getpath($p[:$i])) catch null); . == true);
# Sensitive at $p, above it, or anywhere inside it.
def sensitive_any($s; $p): sensitive($s; $p) or ([(try ($s | getpath($p)) catch null) | .. | select(. == true)] | length > 0);
# An unknown value under one of these keys may hide a location: a location key itself, or a
# container of them (Secret Manager replication, Pub/Sub storage policy, Bunny replication).
# Unknown fields inside such a container that are not locations (e.g. a replica encryption key)
# are not findings. A Secret Manager `auto` block may be global; a Spanner config is its place.
def holds_locations($rc): is_loc_key($rc) or (type == "string" and (ascii_downcase | IN(
  "replication", "replicas", "user_managed", "message_storage_policy",
  "allowed_persistence_regions", "replication_regions")))
  or ($rc.type == "google_secret_manager_secret" and . == "auto")
  or ($rc.type == "google_spanner_instance" and . == "config");
# The path (names only) of every attribute and block in a schema subtree: a block, an attribute,
# or an attribute type, including the fields of object-typed and nested attributes.
def schema_paths: if type == "array" then
    if .[0] == "object" then .[1] | to_entries[] | [.key], [.key] + (.value | schema_paths)
    elif .[0] == "tuple" then .[1][] | schema_paths
    else .[1] | schema_paths end
  elif type != "object" then empty
  elif has("type") then .type | schema_paths
  elif has("nested_type") then .nested_type | schema_paths
  else ((.attributes // {}), (.block_types // {}) | to_entries[]
    | [.key], [.key] + (.value | .block // . | schema_paths)) end;
# Whether attribute path $names (no list indexes) is, or is inside, a value listed in
# derived_when_unknown for resource $rc.
def derived($rc; $names): any($derived[$rc.type] // {} | keys[] | split(".");
  . as $d | ($names | length) >= ($d | length) and $names[:($d | length)] == $d);
# The schema of the unknown value at path $p in block $b: a block, or the attribute the path
# enters (all of it: a superset of the unknown part); null if the schema does not describe it.
def schema_at($b; $p): reduce $p[] as $k ({s: $b, attribute: false};
  if .s == null or .attribute or ($k | type) == "number" then .
  elif .s.block_types[$k] != null then .s = .s.block_types[$k].block
  elif .s.attributes[$k] != null then .s = .s.attributes[$k] | .attribute = true
  else .s = null end) | .s;
# Why an unknown value at path $p may hide a location, or empty if it cannot.
def unknown_risk($rc; $p):
  ($p | map(strings)) as $names
  | if derived($rc; $names) then empty
  elif $p | leaf_key | holds_locations($rc) then "known after apply"
  elif ($rc.type | startswith("google_") | not) then empty
  elif $schema == null then "known after apply; no provider schema to rule out a location"
  else schema_at($schema[$rc.type].block; $p) as $s
    | if $s == null then "known after apply; not in the provider schema"
      elif any($s | schema_paths; (.[-1] | is_loc_key($rc)) and (derived($rc; $names + .) | not))
      then "known after apply"
      else empty end
  end;
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
      ($after | paths(type == "string") | select(leaf_key | is_loc_key($rc))) as $p
      | ($after | getpath($p)) as $v
      | select(bunny_ok($rc; $p | leaf_key; $v) | not)
      | if ($v | uk) then empty
        elif sensitive($sens; $p) then "\($rc.address): \($p | show_path)=(sensitive)"
        else "\($rc.address): \($p | show_path)=\($v)" end
    ),
    (
      (.change.after_unknown // {}) | paths(. == true) as $p
      | unknown_risk($rc; $p) as $why
      | "\($rc.address): \($p | show_path)=(\($why))"
    ),
    (
      select($rc.type == "google_pubsub_topic")
      | ($after.message_storage_policy // []) as $m
      | select(($m | length) != 1 or $m[0].allowed_persistence_regions != ["europe-west2"])
      | "\($rc.address): message_storage_policy.allowed_persistence_regions=\(
          if sensitive_any($sens; ["message_storage_policy"]) then "(sensitive)"
          else $m[0].allowed_persistence_regions // [] | if length == 0 then "(not declared)" else join(",") end
          end)"
    ),
    (
      select($rc.type == "google_spanner_instance" and ($after | has("config")))
      | select($after.config | type != "string" or (test("(^|/)regional-europe-west2$") | not))
      | "\($rc.address): config=\(if sensitive($sens; ["config"]) then "(sensitive)" else $after.config end)"
    ),
    (
      select($rc.type == "google_secret_manager_secret")
      | select([$after.replication[]?.auto[]?] | length > 0)
      | "\($rc.address): replication.auto=global"
    ),
    (
      select($rc.type == "bunnynet_storage_zone")
      | select(($after.replication_regions // []) | length > 0)
      | "\($rc.address): replication_regions=\(
          if sensitive_any($sens; ["replication_regions"]) then "(sensitive)"
          else $after.replication_regions | join(",") end)"
    )
  ] as $bad
| ($changed | length), $bad[]
'

[ $# -ge 1 ] && [ $# -le 2 ] && [ -n "$1" ] || {
  sed -n '6p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
}
environment="$1"
schema_file="${2:-}"

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
# The google_* resource schemas ({type: {block}}), or null without a readable schema. Too big
# for an argument, so jq reads it from a pipe.
google_schemas() {
  [ -n "$schema_file" ] && jq -c '[.provider_schemas | to_entries[]
    | select(.key | test("(^|/)hashicorp/google(-beta)?$")) | .value.resource_schemas | to_entries[]]
    | if length == 0 then null else from_entries end' "$schema_file" 2> /dev/null || echo null
}
report="$(jq -r --argjson global "$global_types" --argjson not_places "$not_places" \
  --argjson derived "$derived_when_unknown" \
  --slurpfile schemas <(google_schemas) '$schemas[0] as $schema | '"$program" 2> /dev/null)" ||
  finish 'could not parse plan' 'could not parse plan'

changed="$(head -n 1 <<< "$report")"
# No plan at all (empty input) gives no count.
[[ "$changed" =~ ^[0-9]+$ ]] || finish 'could not parse plan' 'could not parse plan'
bad="$(tail -n +2 <<< "$report")"
if [ -z "$bad" ]; then
  echo "location-check: ok ($changed created or updated)"
  exit 0
fi
while IFS= read -r line; do echo "location-check: $line"; done <<< "$bad"
count="$(wc -l <<< "$bad" | tr -d ' ')"
finish "$count outside the UK" \
  "$count outside the UK; fix them, or record an exception in tools/scripts/tf-location-check.sh"
