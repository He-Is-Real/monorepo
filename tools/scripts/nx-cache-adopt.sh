#!/usr/bin/env bash
# Lets Nx use an Nx cache restored by actions/cache on a fresh CI runner.
#
# Nx only replays cache entries listed in its index database, and that file is
# named after the machine (/etc/machine-id): <machine-id>-v<schema>.db in the
# workspace-data directory. A new runner can have a different machine ID, so
# Nx would ignore the restored cache ("Unrecognized Cache Artifacts"). This
# renames the restored index to this machine's name. Relies on an
# undocumented Nx file name: if an Nx upgrade changes it, CI just runs cold.
set -euo pipefail
dir="${NX_WORKSPACE_DATA_DIRECTORY:?set NX_WORKSPACE_DATA_DIRECTORY}"
machine="$(cat /etc/machine-id 2> /dev/null)" || exit 0 # no ID: just run cold
shopt -s nullglob
for db in "$dir"/*-v*.db; do
  want="$dir/$machine-${db##*-}"
  if [ "$db" != "$want" ]; then
    mv "$db" "$want"
    echo "Adopted Nx cache index $(basename "$db") as $(basename "$want")"
  fi
done
