#!/usr/bin/env bash
# Whether an earlier tofu-apply run applied something that "Dev behavioural tests" hasn't tested
# yet, for tofu-apply.yml's `behavioural` job (tests: tests/tf-pending.test.mjs).
#
#   GH_TOKEN=… GITHUB_REPOSITORY=owner/repo GITHUB_RUN_ID=<this run> tools/scripts/tf-pending.sh
#
# Prints `true` if an apply job of another run succeeded after the tests last started, else
# `false`. If the history can't be read back that far, prints `true`: an extra test run is
# harmless, a silently skipped one isn't. Exit codes: 64 usage, otherwise 0.
set -euo pipefail

[ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ] || {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
}
api() { gh api "repos/$GITHUB_REPOSITORY/actions/$1" --jq "$2"; }
unsure() {
  echo "$1: assuming untested applies" >&2
  echo true
  exit 0
}

# The tests' latest start: run_started_at is the latest attempt's, and a re-run of an older run
# starts it again, so take the latest across the newest 100 runs. A re-run of an even older run
# is missed, which only makes `since` earlier (an extra test run).
since="$(api 'workflows/dev-behavioural-tests.yml/runs?per_page=100' \
  '[.workflow_runs[].run_started_at] | max // "1970-01-01T00:00:00Z"')" ||
  unsure "couldn't list the Dev behavioural tests runs"

# Runs are listed newest first. Read pages until one reaches runs created before `since`: runs
# are serial, so an older run finished before the tests started (that page's own older runs are
# checked too, in case one was still queued then).
max_pages=10
for ((page = 1; page <= max_pages; page++)); do
  # Line 1: this page's runs updated after `since`, other than this one; line 2: whether the page
  # reaches back before `since` or is the end of the history.
  listing="$(api "workflows/tofu-apply.yml/runs?per_page=100&page=$page" \
    "([.workflow_runs[] | select(.id != $GITHUB_RUN_ID and .updated_at > \"$since\") | .id] | join(\" \")),
     (.workflow_runs | length < 100 or .[-1].created_at < \"$since\")")" ||
    unsure "couldn't list page $page of the tofu-apply runs"
  { read -r candidates; read -r reached; } <<<"$listing"
  for run in $candidates; do
    applied="$(api "runs/$run/jobs?filter=all&per_page=100" \
      "[.jobs[] | select((.name | startswith(\"apply-\")) and .conclusion == \"success\"
        and .completed_at > \"$since\")] | length")" ||
      unsure "couldn't list run $run's jobs"
    if [ "$applied" -gt 0 ]; then
      echo "Run $run applied after the tests last started ($since)" >&2
      echo true
      exit 0
    fi
  done
  if [ "$reached" = true ]; then
    echo false
    exit 0
  fi
done
unsure "$max_pages pages of tofu-apply runs don't reach back to $since"
