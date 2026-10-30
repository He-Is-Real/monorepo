#!/usr/bin/env bash
# What tofu-apply.yml's `superseded` job says when an approved run was superseded
# (tests: tests/tf-superseded.test.mjs).
#
#   tools/scripts/tf-superseded.sh <newer_run> <root>=<plan>,<changes>,<apply> ...
#
#   newer_run  the newer run's number, or empty if it couldn't be found
#   root       gcp, bunny, stripe, cluster, images: the plan job's result, its `changes` output and
#              the apply job's result (any may be empty)
#
# Prints two lines: the message (which roots applied, failed, or weren't applied), then the
# advice. It never says "no action is needed" when a plan or apply failed, and says "nothing
# applied" only when no apply job started: a failed or cancelled apply may have changed some
# resources (Codex, #61).
# Exit codes: 64 usage, else 0.
set -euo pipefail

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
}
[ $# -ge 2 ] || usage
newer="$1"
shift

applied=() failed=() pending=() started=0
for arg in "$@"; do
  [[ "$arg" =~ ^([a-z]+)=([a-z]*),([a-z]*),([a-z]*)$ ]] || usage
  root="${BASH_REMATCH[1]}" plan="${BASH_REMATCH[2]}" changes="${BASH_REMATCH[3]}" apply="${BASH_REMATCH[4]}"
  case "$plan" in
  failure | cancelled) failed+=("$root") ;;
  success)
    if [ "$changes" = true ]; then
      case "$apply" in
      success) applied+=("$root") ;;
      failure | cancelled)
        failed+=("$root")
        started=1
        ;;
      *) pending+=("$root") ;; # skipped: superseded (or never approved)
      esac
    fi
    ;;
  esac
done

list() {
  local out
  printf -v out '%s, ' "$@"
  echo "${out%, }"
}

by='a newer run'
[ -z "$newer" ] || by="run $newer"
parts=()
if [ ${#applied[@]} -eq 0 ] && [ "$started" -eq 1 ]; then
  parts+=('no apply completed')
elif [ ${#applied[@]} -eq 0 ]; then
  parts+=('nothing applied')
else
  parts+=("applied: $(list "${applied[@]}")")
fi
[ ${#failed[@]} -eq 0 ] || parts+=("failed: $(list "${failed[@]}")")
# "nothing applied" alone already says it when nothing failed either.
if [ ${#pending[@]} -gt 0 ] && { [ ${#applied[@]} -gt 0 ] || [ ${#failed[@]} -gt 0 ]; }; then
  parts+=("not applied: $(list "${pending[@]}")")
fi
message="Superseded by $by: $(printf '%s; ' "${parts[@]}")the newer run plans main HEAD."
echo "$message"
if [ ${#failed[@]} -eq 0 ]; then
  echo 'Nothing failed: no action is needed.'
else
  advice="Failed: $(list "${failed[@]}"). Read that job's log: the newer run plans again, but it may fail the same way."
  [ "$started" -eq 0 ] || advice+=' A failed or cancelled apply may have changed some resources; the newer run plans from the real state.'
  echo "$advice"
fi
