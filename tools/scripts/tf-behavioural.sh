#!/usr/bin/env bash
# Whether tofu-apply.yml dispatches "Dev behavioural tests" after a run
# (tests: tests/tf-behavioural.test.mjs).
#
#   tools/scripts/tf-behavioural.sh <release> <pending> <gcp> <bunny> <cluster> <images> -- <gcp> <bunny> <cluster> <images>
#
#   <release>      the target's Release Images when the run started: success, pending, or its
#                  conclusion (failure, cancelled, ...)
#   <pending>      true if an earlier run applied something since the tests last started
#   before --      each root's tf-stage.sh result: `ok` or `blocked: …` (empty = never published)
#   after --       each apply job's result (success|failure|cancelled|skipped|empty)
#   Exactly four of each: a missing value is an error, never a shorter list.
#
# Prints `dispatch` only after a complete deploy of the target's images: Release Images had
# succeeded (so this run rolled them out; otherwise the run its completion triggers decides),
# every stage is ok (nothing failed, was rejected, went stale or was superseded, so dev isn't
# half-deployed) and something was applied, in this run or pending from an earlier one.
# Otherwise `skip: <reason>`. Exit codes: 64 usage, otherwise 0.
set -euo pipefail

usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
}
[ $# -ge 2 ] || usage
release="$1" pending="$2"
shift 2
stages=() applies=() seen=false
for arg in "$@"; do
  if [ "$arg" = -- ]; then seen=true
  elif [ "$seen" = true ]; then applies+=("$arg")
  else stages+=("$arg")
  fi
done
if [ "$seen" != true ] || [ ${#stages[@]} -ne 4 ] || [ ${#applies[@]} -ne 4 ] ||
  { [ "$pending" != true ] && [ "$pending" != false ]; }; then
  usage
fi

case "$release" in
  success) ;;
  pending) echo "skip: Release Images for the target was still running; the run it triggers decides"; exit 0 ;;
  *) echo "skip: Release Images for the target is ${release:-unknown}"; exit 0 ;;
esac
for stage in "${stages[@]}"; do
  if [ "$stage" != ok ]; then
    echo "skip: a stage is ${stage:-missing}"
    exit 0
  fi
done
for apply in "${applies[@]}"; do
  if [ "$apply" = success ]; then
    echo dispatch
    exit 0
  fi
done
if [ "$pending" = true ]; then
  echo dispatch
  exit 0
fi
echo 'skip: nothing was applied'
