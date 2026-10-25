#!/usr/bin/env bash
# `tofu test` for every module with *.tftest.hcl files (Nx: terraform:test, run by ci.yml's
# required job). Offline apart from downloading the locked providers: the tests use mock
# providers or plan-only runs, with no cloud credentials.
#   db-migration, db-identity: the migrate Job's and the identity config's names change iff
#     their content does (D14, D13 B).
#   bunny-state-guard: nothing Bunny is public (the bunny root's pre-plan check).
#   cluster: D48's relaxed consent and D49's dev-seed login are refused outside dev.
#   bunny: D52's token auth is on and only the named service accounts may read the two token
#     auth keys.
#   gcp: api-public-read gets the BUNNY_* settings only when api_public_read_media is set,
#     web_site_url is an https origin, and api-user/api-admin get their own identity, database
#     login, Clerk settings and web's origins.
#   bootstrap: the _Default sink writes to the London log bucket with Google's filter (D101).
#   org: only London locations are allowed, and new projects' logs start in London (D102, D104).
set -euo pipefail
cd "$(dirname "$0")/modules"
for tests in */tests; do
  module="${tests%/tests}"
  compgen -G "$tests/*.tftest.hcl" > /dev/null || continue
  echo "::group::$module"
  # The providers dev runs: a module named like a root (bunny, cluster, gcp) is tested with that
  # root's lock file (providers it lacks are added at their newest), not the registry's newest.
  root_lock="../live/dev/$module/.terraform.lock.hcl"
  if [ -f "$root_lock" ]; then cp "$root_lock" "$module/.terraform.lock.hcl"; fi
  tofu -chdir="$module" init -backend=false -input=false > /dev/null
  tofu -chdir="$module" test
  echo "::endgroup::"
done
