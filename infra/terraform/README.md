# Terraform

**Every cloud change goes through Terraform, including proofs of concept.** No console clicks or
ad-hoc `gcloud … create`. Anything created by hand gets adopted with an `import` block. Read-only
`gcloud`/`kubectl` commands are fine.

Background and decisions (project docs, `context/research/`): `terraform-state-options.html`,
`gke-pods-and-costs.html` (Autopilot + Spot, no load balancer), `db-scaling-and-safe-stops.html`.

## Layout

```
modules/
  bootstrap/   project, APIs, state bucket, CI identities (keyless), budget (alert emails)
  gcp/         network, Artifact Registry, GKE Autopilot, secrets, backups, Cloud Run
  cluster/     inside GKE: External Secrets Operator, SurrealDB (Kustomize overlay), migrations
  db-migration/ the D14 migration bundle and Job name (no providers; `terraform test` offline)
  db-identity/ SurrealDB's identity config: init Secret names, restart hash, marker (same)
live/dev/      one root per concern, applied in this order:
  bootstrap/   developer only (needs billing permissions)        state: dev/bootstrap
  gcp/         developer or the manual GitHub workflow            state: dev/gcp
  images/      developer (local image builds; needs Docker)       state: dev/images
  cluster/     developer or the manual GitHub workflow            state: dev/cluster
```

State is in `gs://heisreal-dev-tfstate` (London, versioned, locked). Roots read each other's
outputs through `terraform_remote_state`. **State holds no secrets:** passwords are write-only
and Google tokens are `ephemeral`, so keep it that way when adding resources.

## Day to day

Log in with `gcloud auth login --update-adc` (your Workspace forces re-authentication now and
then), then `terraform -chdir=infra/terraform/live/dev/<root> init`, `plan`, `apply`.

| Task                        | Command                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Stop / start SurrealDB      | apply `cluster` with `-var surrealdb_replicas=0` (or `1`); the disk is kept                                              |
| Back up SurrealDB now       | apply `cluster` with `-var backup_run=<new id>`; a later plain apply removes the Job                                     |
| Migrate the schema          | apply `cluster`, check the Job, then deploy (SurrealDB README, "Schema migrations")                                      |
| Replace a Cloud Run service | apply `gcp` with `-var run_deletion_protection=false`, then again with that and `-replace=<address>`, then a plain apply |
| Plan as CI would            | prefix with `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=tf-deployer@heisreal-dev.iam.gserviceaccount.com`                        |

## Images

Which build each service runs is committed in `live/<env>/gcp/images.auto.tfvars`, so every apply
converges on git and git history is the deploy log. Decision doc:
`context/research/image-selection-options.html`.

| Value in dev   | Means                                                                                 |
| -------------- | ------------------------------------------------------------------------------------- |
| `"main"`       | newest CI build from `main` (repo `apps`; only `images.yml` on `main` can push there) |
| `"snapshot"`   | newest development build (repo `apps-scratch`; unmerged code; never allowed in prod)  |
| `"…@sha256:…"` | hold the service on exact build                                                       |

| Task                        | How                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| Deploy the latest `main`    | apply `gcp` (manual workflow or local machine); the plan shows the new digest                            |
| Build a snapshot locally    | `pnpm nx run-many -t prune -p api-public-read api-user api-admin workflow`, then apply `images` (Docker) |
| Build a snapshot in CI      | Actions → "Snapshot images" → Run workflow on your branch                                                |
| Run a snapshot in dev, once | apply `gcp` locally with `-var 'image_overrides={"api-public-read"="snapshot"}'`                         |
| Keep dev on snapshots       | set the service to `"snapshot"` in `images.auto.tfvars` on your branch, apply `gcp` locally              |
| Roll back                   | revert the change to `images.auto.tfvars` (or pin the previous digest), then apply                       |

A manual apply from `main` always moves dev back to what `main` says; read the plan. `apps` tags
are immutable. `apps-scratch` keeps the 15 newest builds per service and deletes older ones after
14 days, so don't pin dev to an old snapshot for long.

## CI

| Workflow              | When                                       | Identity                                                                          | Changes the cloud?           |
| --------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------- |
| `terraform-plan.yml`  | automatically on PRs/pushes touching infra | `tf-planner` (gcp, read-only); `tf-cluster-planner` (cluster, `cluster-plan` env) | Dry-run writes in `database` |
| `terraform-apply.yml` | **manual** Run workflow on `main`          | `tf-deployer`: only that workflow, manually                                       | Yes                          |
| `images.yml`          | pushes to `main` that affect a service     | `ci-image-pusher`: only `main` pushes                                             | Pushes to `apps`             |
| `snapshot-images.yml` | **manual** Run workflow, any branch        | `ci-snapshot-pusher`: only that workflow                                          | Pushes to `apps-scratch`     |

All keyless (Workload Identity Federation, limited to this repository's ID; forks get nothing).

**Every PR first gets offline checks** that fail the run on any error: `terraform fmt`, `validate`
of every root, `terraform test` of `modules/db-migration` and `modules/db-identity`, and every
Kustomize overlay rendered and checked with kubeconform (`ci.yml` runs the database integration
suite). Locally: `terraform -chdir=infra/terraform/modules/<module> init -backend=false && … test`.

**The automatic `cluster` plan (D42), and why it's safe.** The kustomization provider diffs with
server-side dry runs, and Kubernetes authorises a dry run exactly like the real request, so the
identity that plans the cluster root, `tf-cluster-planner`, needs create/patch RBAC. Three layers
keep that from becoming write access:

1. **Kubernetes, by construction:** a ValidatingAdmissionPolicy rejects **every write from
   `tf-cluster-planner` that isn't a dry run**, in every namespace and for every kind. Its Role is
   namespaced to `database`: get, create and patch on the overlay's kinds (ConfigMaps,
   ServiceAccounts, Services, ResourceQuotas, the StatefulSet, Jobs, the CronJob,
   NetworkPolicies, ExternalSecrets, the SecretStore). No Secrets, no list, no delete, nothing
   cluster-scoped, and no Kubernetes IAM role: its Google IAM is a custom role that can only
   reach the cluster's API. So even a stolen token can only read those objects and send dry runs:
   it can't start a Job or Pod (which could mount credentials) or change anything. Both live in
   `modules/cluster/planner_dry_run_policy.yaml.tftpl`, tested on a kind cluster in CI
   (`modules/cluster/tests/planner-dry-run-only.sh`).
2. **Google:** the token can only be exchanged for `tf-cluster-planner` through
   `attribute.cluster_plan_gate` (`modules/bootstrap/ci_identity.tf`): environment
   `cluster-plan` and this repository (`modules/bootstrap/cluster_plan_gate.cel.tftpl`, tested with
   GitHub claim fixtures in `modules/bootstrap/tests/`, run by `ci.yml`). (It also names the
   workflow file and the event, but on a
   pull request the workflow comes from the PR's own branch, so those are no boundary: anyone who
   can push a branch can edit the job. The environment and layer 1 are.)
3. **GitHub:** the `cluster-plan` environment requires a reviewer (Joel) for every run, including
   a PR that edits the workflow: GitHub only issues a token with that environment once the run is
   approved. Fork PRs get no OIDC token at all, and the job runs only for this repository's own
   PRs and pushes to `main`, once the repository variable `CLUSTER_PLAN_ENABLED` is `true`.

The gcp plan keeps the separate read-only `tf-planner`. A plan that needs more (a changed
Namespace, the ESO Helm release) fails loudly here and is planned by the manual workflow
(`tf-deployer`) or locally instead.

**Verify after applying the cluster root** (`kubectl auth can-i` doesn't see admission
policies, so try a real write as the planner; you, as a cluster admin, may impersonate it):

```bash
P=tf-cluster-planner@heisreal-dev.iam.gserviceaccount.com
kubectl -n database create configmap planner-probe --from-literal=a=1 --as "$P" --dry-run=server  # allowed
kubectl -n database create configmap planner-probe --from-literal=a=1 --as "$P"   # must be refused:
#   … denied request: tf-cluster-planner may only send dry-run requests
kubectl -n database get secrets --as "$P"                                         # must be forbidden
```

The manual apply has two jobs. **plan** runs a full-refresh plan, shows it in the run summary and
saves it in the state bucket. **apply** waits for approval of the `dev` environment, then applies
exactly that plan. Approving your own run is expected: the gate is that applies are deliberate and
never automatic, not peer review. Automatic plans use `-refresh=false` because the planner may not
take the state lock.

## Who can do what

- **Developers** (`var.developers`): project owners, plus `storage.admin` (the bucket policies are
  authoritative, so owners don't get bucket access by default) and permission to impersonate the
  CI identities.
- **tf-deployer:** only the roles the `gcp` and `cluster` roots need. Custom roles let it manage
  secrets and buckets **without reading secret values or backups**, and it may grant only the GKE
  node role at project level. It could still grant itself more through a resource's own IAM (e.g.
  a secret's), but only by changing Terraform code on `main`. GKE admin also lets it read
  in-cluster Kubernetes Secrets, which ESO copies from Secret Manager.
- **tf-planner:** `roles/viewer` and read access to state. It can't read secret values or backups.
- **tf-cluster-planner** (D42): reach the cluster's API, read state, and in Kubernetes only dry
  runs plus reads of the overlay's kinds in `database` (see CI above). Only runs approved in the
  `cluster-plan` environment can use it.
- **Backups bucket:** only the backup job (create-only) and developers (restores).

## Cost guardrails

- **Budget:** £15/month, alert emails at £3, £7.50 and £15. **No automatic stop**: billing is never
  unlinked and nothing is scaled down for you. If spend runs away, stop SurrealDB (above) and look
  at the billing report. (The automatic stop was dropped on 2026-10-05: it needed an org-policy
  exception because of the org's domain-restricted sharing.)
- **Scale caps:** ResourceQuotas on the `database` and `external-secrets` namespaces, Cloud Run
  `max_instance_count = 2`, SurrealDB replicas validated to 0 or 1.

## Bootstrapping a new environment (e.g. prod)

1. Copy `live/dev` to `live/prod` and change names/IDs. Let `google_project` **create** the project
   with `auto_create_network = false` (dev's was made by hand, so its open-by-default network had
   to be imported and destroyed).
2. First apply of `bootstrap` with local state: `mv backend.tf backend.tf.first-run`, then
   `terraform init` and `terraform apply`.
3. Move the state into the new bucket: `mv backend.tf.first-run backend.tf`, then
   `terraform init -migrate-state`.
4. Apply `gcp` (services start on Google's placeholder image until `apps` has a build), then
   `cluster`.

## Lessons learned

- **Budgets need a quota project.** Only the budget resource uses the `google.billing` provider
  alias; using it everywhere fails on a fresh project whose APIs aren't enabled yet.
- **The Cloud Quotas API needs a quota project with user credentials.** Applying `bootstrap`
  locally (the SSD quota request, `modules/bootstrap/quota.tf`) fails with 403 unless you
  `export GOOGLE_BILLING_PROJECT=heisreal-dev USER_PROJECT_OVERRIDE=true` first.
- **Autopilot nodes have 100 GB SSD boot disks.** With GKE's system node, a second spot node
  exceeds the default 300 GB regional `SSD_TOTAL_GB` quota. Our request for 600 GB was denied on
  the free trial, so our spot Pods share one node in europe-west2-c until it's granted
  ([#35](https://github.com/He-Is-Real/monorepo/issues/35)).
- **The org enforces domain-restricted sharing.** Only `heisreal.today` identities can be granted
  roles: no `allUsers`, no outside service accounts without an org-policy exception.
- **New buckets let every project Viewer read objects** (default `projectViewer` bindings). Our
  buckets use authoritative IAM policies instead, so the read-only planner can't read backups.
- **The Docker provider can't re-read builds** from Docker's containerd image store, so the
  `images` root uses the Docker CLI through `local-exec`, pinned to the current Docker context.
- **Cloud Run reaches SurrealDB by name** (`surrealdb.database.svc.cluster.heisreal-dev.internal`)
  through GKE's additive VPC-scope DNS, which can only be enabled when an Autopilot cluster is
  created.

## Looking at the cluster (read-only)

The control plane has no public IP; it's reached through an IAM-protected DNS endpoint:

```bash
gcloud container clusters get-credentials heisreal-dev --region europe-west2 --dns-endpoint
# needs gke-gcloud-auth-plugin, and switches your kubectl context
# (back with: kubectl config use-context kind-heisreal)
```
