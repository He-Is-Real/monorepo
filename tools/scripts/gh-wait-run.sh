#!/usr/bin/env bash
# Waits for another workflow's run on main for one commit, for tofu-apply.yml: the target's
# Release Images before anything plans, and its CI before anything applies
# (tests: tests/gh-wait-run.test.mjs).
#
#   GH_TOKEN=… GITHUB_REPOSITORY=owner/repo tools/scripts/gh-wait-run.sh <workflow file> <sha>
#
# Looks at the newest push run of <workflow file> on main for <sha> every WAIT_POLL seconds
# (default 15) while it's missing, queued or in progress, for up to WAIT_TIMEOUT seconds (default
# 1800). An API error counts as "not finished yet". Prints the conclusion (success, failure,
# cancelled, …) or `timeout`. Exits 0 only on success; 1 otherwise; 64 usage.
set -euo pipefail

if [ $# -ne 2 ] || [ -z "${GITHUB_REPOSITORY:-}" ] || ! [[ "$2" =~ ^[0-9a-f]{40}$ ]]; then
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
fi
workflow="$1" sha="$2"
poll="${WAIT_POLL:-15}" timeout="${WAIT_TIMEOUT:-1800}"

deadline=$((SECONDS + timeout))
while :; do
  # A re-run keeps its run's id, so the newest id is the one that counts.
  state="$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/$workflow/runs?head_sha=$sha&event=push&branch=main&per_page=20" \
    --jq '.workflow_runs | max_by(.id) |
      if . == null then "missing" elif .status == "completed" then (.conclusion // "unknown") else "pending" end' \
    2>/dev/null)" || state=unreachable
  case "$state" in
    missing | pending | unreachable) ;;
    *)
      echo "$state"
      if [ "$state" = success ]; then exit 0; else exit 1; fi
      ;;
  esac
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "$workflow for $sha still $state after ${timeout}s" >&2
    echo timeout
    exit 1
  fi
  sleep "$poll"
done
