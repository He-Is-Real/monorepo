#!/usr/bin/env bash
# Starts the media worker on this machine against dev (docs/media-runbook.md, "Media ready"):
# Dapr's sidecar (its Pub/Sub building block only, D129) beside apps/media-worker, both signed in
# as the media-worker Google account through your own gcloud login (D126; never a key file).
#
#   tools/scripts/media-worker.sh
#
# Needs: gcloud signed in with application default credentials (`gcloud auth login --update-adc`),
# Dapr's runtime (`mise install`, then `dapr init --slim --runtime-version 1.19.1`), and the repo's
# packages (`pnpm install`). Stop it with Ctrl+C. The sign-in it hands the worker and Dapr is a
# file in $XDG_RUNTIME_DIR (memory, readable by you only), removed when it stops; nothing else is
# written. If your Google sign-in lapses, jobs wait in the queue: sign in again, then restart this.
set -euo pipefail

project=heisreal-dev
region=europe-west2
account="media-worker@$project.iam.gserviceaccount.com"
library=789855 # the dev Stream library (infra/terraform/live/dev/gcp/main.tf)
app_port="${MEDIA_WORKER_APP_PORT:-7341}"
daprd="${DAPRD:-$HOME/.dapr/bin/daprd}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app="$root/apps/media-worker"

die() {
  echo "media-worker: $*" >&2
  exit 1
}

command -v gcloud >/dev/null || die "gcloud isn't installed (docs/tooling-and-accounts.md)"
command -v node >/dev/null || die "node isn't installed (mise install)"
[ -x "$daprd" ] || die "Dapr's runtime isn't installed: run 'mise install', then 'dapr init --slim --runtime-version 1.19.1'"
adc="${CLOUDSDK_CONFIG:-$HOME/.config/gcloud}/application_default_credentials.json"
[ -r "$adc" ] || die "no gcloud application default login: run 'gcloud auth login --update-adc'"

# The result writer's address (Cloud Run), read as you.
writer="$(gcloud run services describe workflow --project "$project" --region "$region" \
  --format='value(status.url)' 2>/dev/null)" ||
  die "can't read the result writer's address: is your gcloud login current? ('gcloud auth login --update-adc')"
[[ "$writer" =~ ^https://[a-z0-9.-]+$ ]] || die "the result writer has no https address yet"

echo "media-worker: building" >&2
(cd "$root" && pnpm nx run media-worker:build --output-style=static >/dev/null) || die "the build failed"

# Your login, acting as media-worker (D126): the standard "impersonated_service_account"
# credentials that `gcloud auth application-default login --impersonate-service-account` writes,
# made from your current login, kept in memory ($XDG_RUNTIME_DIR) and readable by you only.
runtime="$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/heisreal-media-worker.XXXXXX")"
chmod 700 "$runtime"
pids=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$runtime"
}
trap cleanup EXIT INT TERM
(
  umask 077
  ADC="$adc" ACCOUNT="$account" node -e '
    const fs = require("node:fs");
    const source = JSON.parse(fs.readFileSync(process.env.ADC, "utf8"));
    if (source.type !== "authorized_user") {
      console.error("media-worker: your application default login must be your own user login (gcloud auth login --update-adc), not " + source.type);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({
      type: "impersonated_service_account",
      service_account_impersonation_url:
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" + process.env.ACCOUNT + ":generateAccessToken",
      source_credentials: source,
      delegates: [],
    }));
  ' >"$runtime/credentials.json"
)
export GOOGLE_APPLICATION_CREDENTIALS="$runtime/credentials.json"

# The worker first: Dapr asks it for its subscription when it starts.
GCP_PROJECT="$project" MEDIA_WORKER_ACCOUNT="$account" RESULT_WRITER_URL="$writer" \
  BUNNY_STREAM_LIBRARY_ID="$library" BUNNY_STREAM_READONLY_KEY_SECRET=bunny-stream-readonly-key \
  APP_PORT="$app_port" node "$app/dist/main.js" &
pids+=("$!")
for _ in $(seq 1 60); do
  kill -0 "${pids[0]}" 2>/dev/null || die "the worker stopped (see its last log line)"
  (exec 3<>"/dev/tcp/127.0.0.1/$app_port") 2>/dev/null && break
  sleep 0.5
done

# Dapr's sidecar: Pub/Sub only, everything on 127.0.0.1, no metrics, no actors or scheduler.
"$daprd" --app-id media-worker --app-port "$app_port" --app-channel-address 127.0.0.1 \
  --resources-path "$app/dapr/components" --config "$app/dapr/config.yaml" \
  --dapr-listen-addresses 127.0.0.1 --dapr-public-listen-address 127.0.0.1 \
  --dapr-internal-grpc-listen-address 127.0.0.1 \
  --dapr-http-port 3511 --dapr-grpc-port 50011 --enable-metrics=false &
pids+=("$!")

echo "media-worker: running as $account against $project; Ctrl+C stops it" >&2
# Either stopping stops both.
wait -n "${pids[@]}" || true
