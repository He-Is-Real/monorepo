#!/usr/bin/env bash
# Renders every overlay and checks the result against the Kubernetes schemas
# (CRDs from the datreeio catalog). Run through Nx so it is cached and only
# runs when these manifests change:
#
#   pnpm nx validate surrealdb-k8s
#
# Needs kubectl and kubeconform (mise.toml pins kubeconform; `mise install`).
set -euo pipefail
cd "$(dirname "$0")/.."
for overlay in base overlays/local overlays/gke overlays/gke-dev; do
  kubectl kustomize "$overlay" | kubeconform -strict -summary \
    -schema-location default \
    -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
done
