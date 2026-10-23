#!/usr/bin/env bash
# The message tofu-apply.yml's `superseded` job shows when an approved run was superseded
# (tests: tests/tf-superseded.test.mjs).
#
#   tools/scripts/tf-superseded.sh <go1> <go2> <newer_run>
#
#   go1        approve-1's `go` output: `true`, `false` (superseded) or empty (skipped)
#   go2        approve-2's `go` output, the same way
#   newer_run  the newer run's number, or empty if it couldn't be found
#
# Prints one line, or nothing if neither approval was superseded. Exit codes: 64 usage, else 0.
set -euo pipefail

if [ $# -ne 3 ]; then
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
fi
go1="$1" go2="$2" newer="$3"

by='a newer run'
[ -z "$newer" ] || by="run $newer"
if [ "$go1" = false ]; then
  echo "Superseded by $by: nothing applied; the newer run plans main HEAD."
elif [ "$go2" = false ] && [ "$go1" = true ]; then
  echo "Superseded by $by: wave 1 (gcp, bunny) applied, wave 2 (cluster, images) not; the newer run plans main HEAD."
elif [ "$go2" = false ]; then
  echo "Superseded by $by: nothing applied; the newer run plans main HEAD."
fi
