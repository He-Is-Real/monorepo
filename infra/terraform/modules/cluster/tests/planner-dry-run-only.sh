#!/usr/bin/env bash
# Tests planner_dry_run_policy.yaml.tftpl (D42) against a real API server: a throwaway kind
# cluster, the same file rendered for a test user, and requests made as that user through
# impersonation. Never touches GKE. Needs kind, kubectl and python3 (with PyYAML or not: the
# file is rendered with sed and applied as-is).
#
#   infra/terraform/modules/cluster/tests/planner-dry-run-only.sh
set -euo pipefail
cd "$(dirname "$0")/.."

cluster="planner-policy-test-$$"
# A private kubeconfig and cache: never touches your ~/.kube or current context.
export KUBECONFIG KUBECACHEDIR
KUBECONFIG=$(mktemp)
KUBECACHEDIR=$(mktemp -d)
context="kind-$cluster"
planner="tf-cluster-planner@example.iam.gserviceaccount.com"
k() { kubectl --context "$context" "$@"; }
as_planner() { kubectl --context "$context" --as "$planner" "$@"; }
cleanup() {
  kind delete cluster --name "$cluster" >/dev/null 2>&1 || true
  rm -rf "$KUBECONFIG" "$KUBECACHEDIR"
}
trap cleanup EXIT

failures=0
expect() { # expect allow|deny <description> <command…>
  local want=$1 what=$2
  shift 2
  if out=$("$@" 2>&1); then got=allow; else got=deny; fi
  if [ "$got" = "$want" ]; then
    echo "ok   $want: $what"
  else
    echo "FAIL expected $want, got $got: $what"
    echo "     $out"
    failures=$((failures + 1))
  fi
}

kind create cluster --name "$cluster" --wait 120s >/dev/null 2>&1
k create namespace database >/dev/null
k create namespace other >/dev/null
# The file is a YAML list; kubectl wants a List object.
sed "s|\${planner}|$planner|g" planner_dry_run_policy.yaml.tftpl |
  python3 -c 'import sys; print("apiVersion: v1\nkind: List\nitems:"); [print("  " + l) for l in sys.stdin if not l.startswith("#")]' |
  k apply -f - >/dev/null

# The policy is compiled asynchronously: wait until a real write is refused.
for _ in $(seq 1 60); do
  if ! as_planner -n database create configmap probe >/dev/null 2>&1; then break; fi
  as_planner -n database delete configmap probe >/dev/null 2>&1 || k -n database delete configmap probe >/dev/null
  sleep 1
done

k -n database create configmap existing --from-literal=a=1 >/dev/null
k -n database create secret generic creds --from-literal=password=x >/dev/null

echo "As the planner, in database:"
expect allow "dry-run create ConfigMap" as_planner -n database create configmap c1 --from-literal=a=1 --dry-run=server
expect deny "create ConfigMap" as_planner -n database create configmap c1 --from-literal=a=1
refusal=$(as_planner -n database create configmap c1 --from-literal=a=1 2>&1 || true)
if echo "$refusal" | grep -q 'may only send dry-run requests'; then
  echo "ok   the refusal comes from the admission policy (RBAC allows create)"
else
  echo "FAIL the refusal didn't come from the admission policy: $refusal"
  failures=$((failures + 1))
fi
expect allow "dry-run create Job" as_planner -n database create job j1 --image=busybox --dry-run=server -- true
expect deny "create Job (a pod that could mount Secrets)" as_planner -n database create job j1 --image=busybox -- true
expect allow "dry-run patch ConfigMap" as_planner -n database patch configmap existing -p '{"data":{"a":"2"}}' --dry-run=server
expect deny "patch ConfigMap" as_planner -n database patch configmap existing -p '{"data":{"a":"2"}}'
expect deny "create ServiceAccount" as_planner -n database create serviceaccount sa1
expect deny "delete ConfigMap" as_planner -n database delete configmap existing
expect allow "get ConfigMap" as_planner -n database get configmap existing
expect deny "get Secret" as_planner -n database get secret creds
expect deny "list Secrets" as_planner -n database get secrets
expect deny "create Pod" as_planner -n database run p1 --image=busybox --restart=Never -- true
echo "As the planner, elsewhere:"
expect deny "dry-run create ConfigMap in another namespace" as_planner -n other create configmap c2 --from-literal=a=1 --dry-run=server
expect deny "create Namespace" as_planner create namespace evil
echo "Anyone else is unaffected:"
expect allow "admin creates a ConfigMap" k -n database create configmap c3 --from-literal=a=1
k -n database get configmap existing -o jsonpath='{.data.a}' | grep -qx 1 && echo "ok   the planner's patch never landed" || { echo "FAIL the planner's patch landed"; failures=$((failures + 1)); }

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
