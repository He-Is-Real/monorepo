#!/usr/bin/env bash
# Starts the media worker on this machine against dev (docs/media-runbook.md, "Media ready"):
# Dapr's sidecar (its Pub/Sub building block only, D129) beside apps/media-worker, both signed in
# as the media-worker Google account with this machine's own certificate (W1-A; Joel, 2026-11-08):
# nobody's gcloud login, never a Google key file. The worker renews the certificate itself.
#
#   tools/scripts/media-worker.sh
#
# Needs: this machine enrolled once (`tools/scripts/worker-identity.sh enrol <machine>`, again
# only after it was off longer than the certificate lifetime), Dapr's runtime (`mise install`,
# then `dapr init --slim --runtime-version 1.19.1`), ffmpeg 6 or later with libx264 (your system's
# package: it makes audio stories' picture videos), and the repo's packages (`pnpm install`). Stop
# it with Ctrl+C. Settings: IDENTITY_RENEW_HOURS (default 6), WORKER_IDENTITY_DIR. A picture
# video's files live in $XDG_RUNTIME_DIR (memory, readable by you only), removed when it stops.
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

command -v node >/dev/null || die "node isn't installed (mise install)"
command -v ffmpeg >/dev/null || die "ffmpeg isn't installed: install your system's ffmpeg (6 or later, with libx264)"
ffmpeg_major="$(ffmpeg -hide_banner -version | sed -n '1s/^ffmpeg version n\{0,1\}\([0-9]\{1,\}\).*/\1/p')"
[[ "$ffmpeg_major" =~ ^[0-9]+$ ]] && [ "$ffmpeg_major" -ge 6 ] ||
  die "ffmpeg 6 or later is needed (found: $(ffmpeg -hide_banner -version | head -n 1))"
ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' libx264 ' ||
  die "your ffmpeg has no libx264 encoder"
for decoder in webp mjpeg; do
  ffmpeg -hide_banner -decoders 2>/dev/null | grep -q " $decoder " ||
    die "your ffmpeg can't read $decoder pictures"
done
[ -x "$daprd" ] || die "Dapr's runtime isn't installed: run 'mise install', then 'dapr init --slim --runtime-version 1.19.1'"
# A picture video's files go in memory, never on disk: no fallback to /tmp.
[ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "$XDG_RUNTIME_DIR" ] && [ -O "$XDG_RUNTIME_DIR" ] ||
  die "XDG_RUNTIME_DIR isn't set to a directory you own (your desktop session sets it, e.g. /run/user/$(id -u))"
echo "media-worker: building" >&2
(cd "$root" && pnpm nx run media-worker:build --output-style=static >/dev/null) || die "the build failed"

# This machine's identity (W1-A): the standard external_account credentials for its certificate,
# which the worker and Dapr both use. `check` refuses a missing or expired certificate (then:
# worker-identity.sh enrol) and prints the project number.
identity_dir="${WORKER_IDENTITY_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/heisreal/worker-identity}"
export WORKER_IDENTITY_DIR="$identity_dir"
number="$(node "$app/dist/identity.js" check)" || exit 1
[[ "$number" =~ ^[0-9]+$ ]] || die "the identity directory has no project number: enrol again"
export GOOGLE_APPLICATION_CREDENTIALS="$identity_dir/credentials.json"
# The result writer's address: Cloud Run's deterministic one (no gcloud needed).
writer="https://workflow-$number.$region.run.app"

# A picture video's files, in memory, each job in a folder of its own removed when it ends.
runtime="$(mktemp -d "$XDG_RUNTIME_DIR/heisreal-media-worker.XXXXXX")"
chmod 700 "$runtime"
pids=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$runtime"
}
trap cleanup EXIT INT TERM
mkdir -m 700 "$runtime/work"
# Dapr's sidecar sends this with every call to the worker, which refuses anything without it:
# no other program, and no web page posting to 127.0.0.1, can hand the worker a job. New each run.
APP_API_TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
export APP_API_TOKEN
# And the sidecar's own API needs this (it also offers nothing but its health check,
# apps/media-worker/dapr/config.yaml), so nobody can reach the worker through Dapr either.
DAPR_API_TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
export DAPR_API_TOKEN

# The worker first: Dapr asks it for its subscription when it starts.
GCP_PROJECT="$project" MEDIA_WORKER_ACCOUNT="$account" RESULT_WRITER_URL="$writer" \
  BUNNY_STREAM_LIBRARY_ID="$library" BUNNY_STREAM_READONLY_KEY_SECRET=bunny-stream-readonly-key \
  MEDIA_WORKER_WORK_DIR="$runtime/work" \
  MEDIA_WORKER_DEFAULT_PICTURE="$app/assets/default-audio-background.jpg" \
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
