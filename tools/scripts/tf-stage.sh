#!/usr/bin/env bash
# The stage decision tofu-apply.yml records after each root (tests: tests/tf-stage.test.mjs).
#
#   tools/scripts/tf-stage.sh <prev> <selected> <plan_result> <changes> <go> <apply_result>
#
#   prev          the previous stage's result: `ok`, or anything else (blocked)
#   selected      `true`, or `false` when the root isn't part of this run (images not requested)
#   plan_result   the plan job's result (success|failure|cancelled|skipped|empty)
#   changes       the plan job's `changes` output (`true`/`false`)
#   go            the approval job's `go` output: `true` only if approved and not superseded
#   apply_result  the apply job's result
#
# Prints `ok` or `blocked: <reason>`. Failed, rejected, stale and superseded block every later
# stage; "not selected" and "no changes" don't. Any result other than `success` blocks.
# Exit codes: 64 usage, otherwise 0.
set -euo pipefail

if [ $# -ne 6 ]; then
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
fi
prev="$1" selected="$2" plan="$3" changes="$4" go="$5" apply="$6"

if [ "$prev" != ok ]; then
  echo 'blocked: upstream'
elif [ "$selected" = false ]; then
  echo ok
elif [ "$plan" != success ]; then
  echo "blocked: plan ${plan:-not run}"
elif [ "$changes" = false ]; then
  echo ok
elif [ "$changes" != true ]; then
  echo "blocked: plan published no changes output"
elif [ "$go" != true ]; then
  echo 'blocked: superseded or rejected'
elif [ "$apply" != success ]; then
  echo "blocked: apply ${apply:-not run}"
else
  echo ok
fi
