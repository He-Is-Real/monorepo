#!/usr/bin/env bash
# Whether tofu-apply.yml dispatches "Dev behavioural tests" after a run
# (tests: tests/tf-behavioural.test.mjs).
#
#   tools/scripts/tf-behavioural.sh <stage>... -- <apply_result>...
#
#   stage         each root's tf-stage.sh result (gcp, bunny, cluster, images): `ok` or `blocked: …`
#   apply_result  each apply job's result (success|failure|cancelled|skipped|empty)
#
# Prints `dispatch` only after a complete deploy: every stage is ok (nothing failed, was
# rejected, went stale or was superseded, so dev isn't half-deployed) and at least one apply
# succeeded (something changed). Otherwise `skip: <reason>`. Exit codes: 64 usage, otherwise 0.
set -euo pipefail

stages=() applies=() seen=false
for arg in "$@"; do
  if [ "$arg" = -- ]; then seen=true
  elif [ "$seen" = true ]; then applies+=("$arg")
  else stages+=("$arg")
  fi
done
if [ "$seen" != true ] || [ ${#stages[@]} -eq 0 ] || [ ${#applies[@]} -eq 0 ]; then
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
fi

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
echo 'skip: nothing was applied'
