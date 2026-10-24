#!/usr/bin/env bash
# web:e2e-webkit (T9): the e2e suite's WebKit projects (Safari's engine), inside Playwright's
# own Ubuntu image, the same locally and in CI: Playwright's WebKit needs Ubuntu's libraries,
# which other Linux hosts (Joel's Arch) don't have. The image is pinned by digest and must match
# the installed @playwright/test. Extra arguments go to `playwright test`.
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE_VERSION=1.64.1
IMAGE="mcr.microsoft.com/playwright@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea" # v1.64.1-noble
installed="$(node -p "require('@playwright/test/package.json').version")"
if [ "$installed" != "$IMAGE_VERSION" ]; then
  echo "@playwright/test is $installed but the WebKit image is $IMAGE_VERSION: update IMAGE in $0" >&2
  exit 1
fi
env_args=(-e E2E_WEBKIT=1 -e HOME=/tmp)
for name in CI E2E_WEB_PORT E2E_SIGNED_IN_PORT E2E_CLERK_PORT E2E_STUB_PORT; do
  if [ -n "${!name:-}" ]; then env_args+=(-e "$name=${!name}"); fi
done
exec docker run --rm --network host --ipc=host -u "$(id -u):$(id -g)" "${env_args[@]}" \
  -v "$PWD:/work" -w /work "$IMAGE" \
  node node_modules/@playwright/test/cli.js test -c apps/web/e2e/playwright.config.ts "$@"
