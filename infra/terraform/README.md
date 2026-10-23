# OpenTofu

**Every cloud change goes through OpenTofu, including proofs of concept** (D54: OpenTofu 1.13.2,
never Terraform; the directory keeps its name). No console clicks or ad-hoc `gcloud … create`.
Anything created by hand gets adopted with an `import` block. Read-only `gcloud`/`kubectl`
commands are fine. Exceptions: the Clerk instance's settings (`infra/clerk`) and
[recovering a KMS key version](#break-glass-recover-a-kms-key-version).

Background and decisions (project docs, `context/research/`): `terraform-state-options.html`,
`gke-pods-and-costs.html` (Autopilot + Spot, no load balancer), `db-scaling-and-safe-stops.html`,
`m1-dev-data-decisions.html` (D54) and `opentofu-access-model-decision.html` (D57: C).

## Layout

```
modules/
  bootstrap/   project, APIs, state bucket, KMS keys, CI identities (keyless), budget, Bunny account key secret
  gcp/         network, Artifact Registry, GKE Autopilot, secrets, backups, Cloud Run, dev-seed Job (dev)
  cluster/     inside GKE: External Secrets Operator, SurrealDB (Kustomize overlay), migrations
  db-migration/ the D14 migration bundle and Job name (no providers; `tofu test` offline)
  db-identity/ SurrealDB's identity config: init Secret names, restart hash, marker (same)
  bunny/       Bunny.net: Stream library, storage zone + pull zone, app keys in Secret Manager
  bunny-state-guard/ the bunny root's "never public" check (no providers; tested)
live/dev/      one root per concern, applied in this order:
  bootstrap/   developer only, locally (needs billing permissions)  state: dev/bootstrap
  gcp/         tofu-apply.yml (approved) or a developer              state: dev/gcp
  images/      a developer (Docker), or tofu-apply.yml on request    state: dev/images
  cluster/     tofu-apply.yml (approved) or a developer              state: dev/cluster
  bunny/       tofu-apply.yml (approved, as tf-bunny) or a developer state: dev/bunny (private)
```

State is in `gs://heisreal-dev-tfstate` (London, versioned, 30 days of old versions, 7 days of
soft delete, locked), encrypted with Cloud KMS ([Encryption](#encryption)). Roots read each
other's outputs through `terraform_remote_state`. **State holds no secrets:** passwords are
write-only and Google tokens are `ephemeral`, so keep it that way when adding resources. The one
approved exception is `bunny` ([below](#bunnynet)): nothing reads its state through
`terraform_remote_state`, and only developers and `tf-bunny` can read or decrypt it.

## Day to day

Log in with `gcloud auth login --update-adc` (your Workspace forces re-authentication now and
then) and `mise install` (OpenTofu 1.13.2; `tf.sh` refuses any other version). Then run every root
through **`tools/scripts/tf.sh <root> <tofu args>`**:

| Command                                | Does                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `tf.sh <root> init` / `plan` / `apply` | `tofu -chdir=infra/terraform/live/dev/<root> …`                                 |
| `tf.sh <root> plan-summary <planfile>` | changed addresses, actions and a count only (what CI publishes; safe for bunny) |
| `tf.sh bunny-cli <args>`               | the bunny CLI with the account key from Secret Manager, for that one process    |
| `tf.sh bunny-mask secrets\|state`      | CI only: `::add-mask::` every Bunny key before tofu runs                        |

**Identity.** Locally `tf.sh` acts as the root's CI identity, so a local plan sees what CI sees:
gcp, images and cluster as `tf-deployer`, bunny as `tf-bunny` (developers hold Token Creator on
both), bootstrap always as you. `TF_SH_IDENTITY=self` uses your own credentials; an email picks
another account. In GitHub Actions it uses the job's ambient credentials.

**Refusals.** `TF_LOG*` and GitHub step debug (`RUNNER_DEBUG=1`): debug logs print API responses,
Bunny keys and secret payloads. `TF_ENCRYPTION` is always unset (it would replace the encryption
config in code). For bunny: `state pull`, `show -json` and `output -json`, which print the keys.

| Task                        | Command                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Stop / start SurrealDB      | `tf.sh cluster apply -var surrealdb_replicas=0` (or `1`); the disk is kept                                       |
| Back up SurrealDB now       | `tf.sh cluster apply -var backup_run=<new id>`; a later plain apply removes the Job                              |
| Migrate the schema          | apply `cluster`, check the Job, then deploy (SurrealDB README, "Schema migrations")                              |
| Replace a Cloud Run service | apply `gcp` with `-var run_deletion_protection=false`, then again with that and `-replace=<address>`, then plain |
| Plan with your own rights   | `TF_SH_IDENTITY=self tools/scripts/tf.sh <root> plan`                                                            |

A local apply is as deliberate as an approval in CI: read the plan first. After a local apply
from a branch, the next `tofu-apply.yml` run moves dev back to what `main` says.

## Images

Which build each service runs is committed in `live/<env>/gcp/images.auto.tfvars`, so every apply
converges on git and git history is the deploy log. Decision doc:
`context/research/image-selection-options.html`.

| Value in dev   | Means                                                                                 |
| -------------- | ------------------------------------------------------------------------------------- |
| `"main"`       | newest CI build from `main` (repo `apps`; only `images.yml` on `main` can push there) |
| `"snapshot"`   | newest development build (repo `apps-scratch`; unmerged code; never allowed in prod)  |
| `"…@sha256:…"` | hold the service on exact build                                                       |

| Task                        | How                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| Deploy the latest `main`    | approve the gcp plan of the `tofu-apply.yml` run Release Images triggers; the plan shows the new digest |
| Build a snapshot locally    | `pnpm nx run-many -t prune -p $(tools/scripts/image-services.sh)`, then `tf.sh images apply` (Docker)   |
| Build a snapshot in CI      | Actions → "Snapshot images" → Run workflow on your branch                                               |
| Run a snapshot in dev, once | apply `gcp` locally with `-var 'image_overrides={"api-public-read"="snapshot"}'`                        |
| Keep dev on snapshots       | set the service to `"snapshot"` in `images.auto.tfvars` on your branch, apply `gcp` locally             |
| Roll back                   | revert the change to `images.auto.tfvars` (or pin the previous digest), then apply                      |

An apply from `main` always moves dev back to what `main` says; read the plan. `apps` tags
are immutable. `apps-scratch` keeps the 15 newest builds per service and deletes older ones after
14 days, so don't pin dev to an old snapshot for long.

## CI

| Workflow                    | When                                                      | Identity                                                                                          | Changes the cloud?                              |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `tofu-plan.yml`             | automatically on PRs touching infra                       | `tf-planner` (gcp, images; read-only); `tf-cluster-planner` (cluster, `cluster-plan` env)         | Dry-run writes in `database`                    |
| `tofu-apply.yml`            | every push to `main`, every Release Images run, dispatch  | `tf-deployer` (gcp, cluster, images), `tf-bunny` (bunny): only this workflow and drift, on `main` | Yes, after an approval in the `dev` environment |
| `tofu-drift.yml`            | weekly (Monday 06:17 UTC) and dispatch                    | `tf-deployer` (gcp, cluster), `tf-planner` (bootstrap), `tf-bunny` (bunny)                        | No                                              |
| `images.yml`                | pushes to `main` that affect a service ("Release Images") | `ci-image-pusher`: only `main` pushes                                                             | Pushes to `apps`                                |
| `snapshot-images.yml`       | **manual** Run workflow, any branch                       | `ci-snapshot-pusher`: only that workflow                                                          | Pushes to `apps-scratch`                        |
| `reset-dev-data.yml`        | **manual** Run workflow, `main` (D50)                     | `ci-dev-seeder`: only this and `dev-behavioural-tests.yml`, dispatched on `main`                  | Starts the dev-seed Job (dummy data, no apply)  |
| `dev-behavioural-tests.yml` | **manual** Run workflow, `main` (D50)                     | `ci-dev-seeder` for the reset job; the test job has no identity                                   | Resets dev data, then tests the dev URLs        |

All keyless (Workload Identity Federation, limited to this repository's ID; forks get nothing).
The repository is public, so **Actions logs, summaries and artifacts are world-readable**
([Bunny.net](#bunnynet) for how its jobs handle that).

**`tofu-plan.yml` (PRs, advice only).** Offline checks first, failing the run on any error:
`tofu fmt`, `validate` of every root, the encryption key names and enforcement, the Bunny key
attributes being sensitive, `tofu test` of `modules/db-migration`, `modules/db-identity` and
`modules/bunny-state-guard`, every Kustomize overlay rendered and checked with kubeconform, and the
planner's dry-run-only policy on kind (`ci.yml` runs the database integration suite). Locally:
`tofu -chdir=infra/terraform/modules/<module> init -backend=false && … test`. Then the roots the PR
touches (`tools/scripts/tf-roots.sh`) are planned with `-refresh=false -lock=false` (the planners
can't take the lock or read secret values). **bunny is never planned on a PR** (tf-bunny is
available only on `main`); bootstrap is planned and applied locally.

**`tofu-apply.yml` (merge → plan → approve → apply).**

- **One run at a time** (concurrency group `tofu-apply`, never cancelled in progress). GitHub keeps
  at most one pending run and drops older pending ones, which loses nothing because:
- **every run plans every root** at `main` HEAD, resolved once by the first job (gcp, cluster and
  bunny; images only when dispatched with `images`; never bootstrap). Unchanged roots say "No
  changes" and skip their apply. Every Release Images completion, success or failure, triggers a
  full run, so a new image in `apps` is planned as soon as it exists.
- **Two approval waves.** Wave 1: gcp and bunny plan in parallel; if either changes, `approve-1`
  waits for one approval in `dev`, then both apply their saved plans. Wave 2: cluster (and images)
  plan **after** gcp's apply, against its fresh outputs; if either changes, `approve-2` asks once
  more. A single-root change asks once; gcp + cluster asks twice.
- **Each apply applies exactly its saved plan** (KMS-encrypted, in `gs://heisreal-dev-tfstate/plans/`,
  or `dev/bunny/plans/` for bunny; unapproved plans expire after 7 days). OpenTofu refuses it if
  state changed meanwhile.
- **Superseded runs.** If `main` moves while a run waits, its plan summaries say **"⚠ superseded by
  <sha>: reject this run; the next run plans again."** Reject it. Approving it applies nothing:
  the approve job re-checks `main` after the click. Then the `superseded` job warns "Superseded
  by run N: …" and fails on purpose, so the run is red rather than a green tick. Its summary
  names the roots that applied, failed or weren't applied. If one failed, read that job's log;
  otherwise nothing is needed: the newer run plans `main` HEAD.
- **Failed, rejected, stale or superseded stops every later stage** (`tools/scripts/tf-stage.sh`;
  the `stage-*` jobs write each root's result to the summary). A rejected wave 1 skips wave 2.
- **To recover from anything** (a failed, rejected or superseded run, or an image built while a
  run was in flight): Actions → "OpenTofu apply" → Run workflow. It plans everything again.

**`tofu-drift.yml`** runs a full-refresh plan without the lock; any change fails the job and the
summary lists the addresses. bootstrap is included read-only (as `tf-planner`); images never (its
plan compares local build output). A Cloud Run image diff on gcp usually means a newer image is in
`apps` than the one deployed: the next `tofu-apply.yml` run plans it.

**The automatic `cluster` plan (D42, the `plan-cluster` job in `tofu-plan.yml`), and why it's safe.** The kustomization provider diffs with
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
   PRs, once the repository variable `CLUSTER_PLAN_ENABLED` is `true`.

**Verify after applying the cluster root** (`kubectl auth can-i` doesn't see admission
policies, so try a real write as the planner; you, as a cluster admin, may impersonate it):

```bash
P=tf-cluster-planner@heisreal-dev.iam.gserviceaccount.com
kubectl -n database create configmap planner-probe --from-literal=a=1 --as "$P" --dry-run=server  # allowed
kubectl -n database create configmap planner-probe --from-literal=a=1 --as "$P"   # must be refused:
#   … denied request: tf-cluster-planner may only send dry-run requests
kubectl -n database get secrets --as "$P"                                         # must be forbidden
```

## Who can do what

| Identity                      | Used by                                                                  | Can reach                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| developers (`var.developers`) | people                                                                   | everything: project owners, `storage.admin` on the buckets, Token Creator on the CI identities, both KMS keys                                                                |
| `tf-planner`                  | any workflow in this repository (`tofu-plan.yml`, drift)                 | `roles/viewer`, `iam.securityReviewer`, read state (not `dev/bunny/`), `tofu-state`, bucket metadata. No secret values or backups                                            |
| `tf-cluster-planner` (D42)    | `tofu-plan.yml` on PRs, in the `cluster-plan` environment                | the cluster's API (dry runs and reads in `database` only, see CI), read state (not `dev/bunny/`), `tofu-state`                                                               |
| `tf-deployer`                 | `tofu-apply.yml` and `tofu-drift.yml` on `main`                          | what the gcp, cluster and images roots manage; state (not `dev/bunny/`), `tofu-state`, saved plans in `plans/`. No `bunny-*` secrets, no `tofu-bunny`, no bucket IAM changes |
| `tf-bunny` (D57)              | `tofu-apply.yml` and `tofu-drift.yml` on `main`; developers              | the bunny root only: `dev/bunny/` (state, plans, logs), the `bunny-*` secrets, `tofu-bunny`; `iam.securityReviewer` for the never-public guard                               |
| `ci-image-pusher`             | `images.yml` on a push to `main`                                         | push to `apps`                                                                                                                                                               |
| `ci-snapshot-pusher`          | `snapshot-images.yml` (manual, any branch)                               | push to `apps-scratch`                                                                                                                                                       |
| `ci-dev-seeder` (D50)         | `reset-dev-data.yml`, `dev-behavioural-tests.yml` (dispatched on `main`) | run and watch the `dev-seed` Cloud Run Job only (granted on that Job by the gcp root): no overrides, no secrets, no logs                                                     |

The gates are CEL expressions over GitHub's OIDC claims (`modules/bootstrap/*.cel.tftpl`, tested
with claim fixtures in `modules/bootstrap/tests/`): ref, workflow file and event. Environments
aren't part of the deploy and bunny gates; the `dev` approval is "read the plan", not access
control.

- **tf-deployer** has custom roles that manage secrets and buckets **without reading secret values
  or backups**, and it may grant only the GKE node role at project level. Its secrets and buckets
  roles carry IAM conditions that exclude every `bunny-*` secret and the state bucket, and its
  state-bucket binding excludes `dev/bunny/` (`modules/bootstrap/ci_identity.tf`, `state.tf`). GKE
  admin also lets it read in-cluster Kubernetes Secrets, which ESO copies from Secret Manager.
  **tf-deployer could grant itself access to Bunny through its service-account roles. That's
  accepted (D57).** It would take a change to code on `main` and an approved apply.
- **Backups bucket:** only the backup job (create-only) and developers (restores).
- **`dev/bunny/`:** readable by developers and `tf-bunny`, and by Google-managed service agents
  acting for their own services; its state is encrypted with `tofu-bunny`, which only developers
  and `tf-bunny` can use. Object names stay listable for the other CI identities, contents don't.

## Dev data (D49, D50)

The `dev-seed` Cloud Run Job (`modules/gcp/dev_seed.tf`, app `apps/dev-seed`) resets the dev
database to the D47 dummy dataset in one transaction. Dev only: `dev_seed` in the gcp module and
`dev_seed_login` in the cluster module refuse any project but `heisreal-dev` (tested in
`modules/cluster/tests/dev_seed.tftest.hcl` and `modules/db-identity/tests`), like D48's
`dev_consent_relaxed`. The Job signs in as `dev_seed`, a system user (EDITOR) that SurrealDB's
startup init creates only with `dev_seed_login`; its password is `surreal-dev-seed-password`.
Starting the Job is an operation, not an infrastructure change: no apply. `ci-dev-seeder` may
start it from "Reset dev data" and "Dev behavioural tests" on `main`, nothing else. Media were
uploaded once by a developer (`apps/dev-seed/README.md`); the Job never talks to Bunny.

## Encryption

State and saved plans are encrypted with Cloud KMS (`gcp_kms` key provider, `aes_gcm`, enforced:
no root reads or writes plaintext). Each root's config is in `live/dev/<root>/encryption.tf`.

| Key (keyring `tofu`, europe-west2) | Encrypts                                        | Who can use it                                                |
| ---------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| `tofu-state`                       | bootstrap, gcp, images and cluster state; plans | developers, `tf-deployer`, `tf-planner`, `tf-cluster-planner` |
| `tofu-bunny`                       | bunny state and plans                           | developers, `tf-bunny`                                        |

- Every reader needs `cloudkms.cryptoKeyEncrypterDecrypter`: OpenTofu calls `Encrypt` on every run.
- Both keys rotate yearly. **Rotation doesn't re-encrypt** old states, plans or object generations,
  so **never disable or destroy a key or any key version**: every version must stay enabled.
  `roles/owner` can disable and destroy them, so this rule is followed by hand. A destroy is
  scheduled for 120 days (the maximum) and can be undone in that window ([Break-glass](#break-glass-recover-a-kms-key-version)).
- The keyring, keys and key IAM carry `prevent_destroy` and `destroy = false`: removed from config,
  they're only forgotten, never destroyed. **Never revert bootstrap wholesale.**
- About $0.06/month per active key version.
- A broken encryption block passes `validate` (it isn't evaluated offline); only a plan against the
  real backend tests it. A corrupted state object is restored from its previous generation:
  `gcloud storage ls -a gs://heisreal-dev-tfstate/dev/<root>/default.tfstate`, then
  `gcloud storage cp 'gs://…/default.tfstate#<generation>' gs://…/default.tfstate`. Don't copy
  bunny state to disk: it holds keys.

## Break-glass: recover a KMS key version

This is the only change allowed outside OpenTofu (Clerk config is the other standing exception).
Key versions aren't OpenTofu resources, so there's nothing to import.

**When:** a version of `tofu-state` or `tofu-bunny` is `DESTROY_SCHEDULED` (you have 120 days) or
`DISABLED`. Symptom: plans fail with a KMS decrypt error.

**Who:** a developer (project owner; `roles/owner` holds `cloudkms.cryptoKeyVersions.restore` and
`.update`). Tell Joel first.

1. Find the version:

   ```bash
   gcloud kms keys versions list --key tofu-state --keyring tofu --location europe-west2 --project heisreal-dev \
     --format='table(name.basename(),state,destroyTime)'
   ```

2. If it is `DESTROY_SCHEDULED`, restore it. A restored version comes back `DISABLED`:

   ```bash
   gcloud kms keys versions restore <v> --key <key> --keyring tofu --location europe-west2 --project heisreal-dev
   ```

3. Enable it (also the fix for a plain `DISABLED` version):

   ```bash
   gcloud kms keys versions enable <v> --key <key> --keyring tofu --location europe-west2 --project heisreal-dev
   ```

4. Confirm there is no drift: `tools/scripts/tf.sh bootstrap plan -detailed-exitcode` → 0, then plan
   every root (`tf.sh <r> plan -lock=false -detailed-exitcode`, bunny as tf-bunny) with the same
   results as before.
5. Record what happened and why in `docs/delivery-status.md`.

Anything else (key IAM, key settings, a key dropped from config) goes through OpenTofu: fix the
code and apply bootstrap. A key removed from config is only forgotten (`skip_destroy`); adopt it
again with an `import` block.

## Bunny.net

`live/dev/bunny` (module `modules/bunny`) holds the dev media services: Stream library
`heisreal-dev-media` (video and audio), storage zone `heisreal-dev-images` (Standard tier,
London, S3-compatible, no replication) and pull zone `heisreal-dev-images`
(`heisreal-dev-images.b-cdn.net`, EU + US routing) in front of it. No custom hostnames (D7).
Transcription, smart titles/descriptions, content tagging, MP4 fallback, kept originals, premium
encoding, Optimizer, Origin Shield, Perma-Cache and WebSockets are all set off explicitly, so
turning one on in the dashboard shows up as drift. (Automatic chapters and moments aren't in the
provider; both are off by default and would switch transcribing on, which shows as drift.)

**Keys and state.** The provider stores the library keys, the zone passwords and the pull zone's
token key in state, with no write-only alternative: the approved exception in `AGENTS.md` (D57 C).
Mitigation: only developers and `tf-bunny` can read `dev/bunny/` or use `tofu-bunny`, which
encrypts its state and saved plans; CI gets `tf-bunny` only on `main`, in `tofu-apply.yml` and
`tofu-drift.yml`, never on a PR; and debug logs are refused. The account API key lives in Secret
Manager (`bunny-account-api-key`, container from the `bootstrap` root) and reaches the provider
through an `ephemeral` read, so it's in neither state nor plans. The keys the apps will need are
copied into `bunny-stream-api-key` and `bunny-storage-password` with write-only versions; apps read
them through `libs/secrets`. No service has access yet: grants come with the milestone that uses
them (M2, api-user).

**The never-public guard.** Before every plan the root reads the IAM policies of the state bucket,
the project, the `tofu` keyring and both keys, and every `bunny-*` secret, and refuses to plan if
`allUsers` or `allAuthenticatedUsers` holds any role on any of them (`modules/bunny-state-guard`,
tested offline). Organisation-level checks are in `tools/scripts/check-bunny-fences.sh` (below);
`tf-bunny` has no organisation permission.

**Running it.** `tools/scripts/tf.sh bunny <command>` runs as `tf-bunny` by default, from any
branch. `tf.sh bunny-cli <args>` runs the bunny CLI with the account key in `BUNNYNET_API_KEY` for
that one process, so you never need `bunny login`, a profile or a `.env` file.

**In CI (public logs).** Bunny jobs mask every `bunny-*` secret before any tofu step, and the five
keys from state right after `init` (`tf.sh bunny-mask`). Masking is a backstop (it misses encoded
or split values), so tofu's own output never goes to the public log either: it goes to a private
raw log, and the summary gets only `tf.sh bunny plan-summary` (addresses, actions, a count), an exit
code and the log's name. No Bunny plan is ever an artifact.

**Reading the raw logs.** `gs://heisreal-dev-tfstate/dev/bunny/logs/<run_id>-<attempt>-<job>.log`
(`plan-bunny`, `apply-bunny`, `drift-bunny`), readable by developers and `tf-bunny`. A failed job's
summary names the file. They can hold Bunny keys in provider errors, so read them in the terminal
and don't paste them anywhere:

```bash
gcloud storage ls gs://heisreal-dev-tfstate/dev/bunny/logs/ | tail
gcloud storage cat gs://heisreal-dev-tfstate/dev/bunny/logs/<run_id>-<attempt>-plan-bunny.log | less
```

They're deleted after 7 days (about 14 more with versioning and soft delete), as are unapproved
saved plans under `dev/bunny/plans/`.

| Task                           | How                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First setup (once)             | apply `bootstrap` (private state prefix, tf-bunny, `tofu-bunny`, secret container), add the account key (next row), then `tf.sh bunny init` and `apply`                                                                                                                                              |
| Add or replace the account key | `jq -j .profiles.default.api_key ~/.config/bunnynet.json \| gcloud secrets versions add bunny-account-api-key --project heisreal-dev --data-file=-` (from a `bunny login` profile; never echo it), then `bunny logout`                                                                               |
| Check the AI features are off  | `tools/scripts/tf.sh bunny-cli api GET /videolibrary/<id> \| jq '{EnableTranscribing, EnableTranscribingChaptersGeneration, EnableTranscribingMomentsGeneration, EnableContentTagging, KeepOriginalFiles, EnableMP4Fallback, ReplicationRegions}'` (keep the filter: the response includes the keys) |
| Rotate a library or zone key   | reset it at Bunny (`tf.sh bunny-cli ...`), then let `tofu-apply.yml` (or `tf.sh bunny apply`) apply it: the new value becomes a new secret version; disable the old one once services restarted                                                                                                      |

**Check the fences after applying `bootstrap`** (and after the bunny root):
`tools/scripts/check-bunny-fences.sh`. Read-only, it impersonates `tf-deployer` and `tf-bunny` for
five minutes and checks that tf-deployer still has no route to anything Bunny's while its own
secrets, buckets and state stay manageable; that tf-bunny reaches exactly the bunny root's state,
the `bunny-*` secrets and `tofu-bunny`; and, as you, that nothing in the organisation's policy is
public. Policy Troubleshooter can't check these conditions: it doesn't fill in `resource.type`, so
it reports them as granted.

**Uploads (built in M2; services never handle media bytes, as in the prototype).** Video and
audio: api-user creates the video (`POST video.bunnycdn.com/library/{libraryId}/videos` with the
library key) and returns `libraryId`, `videoId`, `expirationTime` and
`signature = sha256(libraryId + libraryKey + expirationTime + videoId)`; the browser uploads to
`https://video.bunnycdn.com/tusupload` with those as headers. Images: api-user signs a
short-lived S3 presigned PUT for `https://uk-s3.storage.bunnycdn.com/heisreal-dev-images/<key>`
(SigV4; access key = zone name, secret = `bunny-storage-password`), which is why the zone is
S3-compatible (create-time only). Bunny documents presigned URLs (S3 API in public preview since
2026-07), but only shows GET; **before M2 relies on it, prove a presigned PUT** with one tiny
file (then delete it), including whether signed `Content-Length`/`Content-Type` are enforced.
If not, the options are in #39 ("Questions for Joel").

**M2 prerequisite, before the first draft upload:** token authentication on image delivery (pull
zone `token_auth_enabled`, signed URLs from api-user) and on Stream playback and embeds (library
`view_token_authentication_required` and `cdn_token_authentication_required`). Drafts are Art 9
data and Bunny URLs are otherwise public to anyone who has them. Neither needs a custom domain.
Until then the dev library and zone hold no testimonies.

**Cost:** Bunny bills at least $1 a month per account; dev usage (a few test files) stays under
it. Storage is $0.01/GB/month (Standard, one region), CDN $0.01/GB in EU/US, free encoding.

## Cost guardrails

- **Budget:** £15/month, alert emails at £3, £7.50 and £15. **No automatic stop**: billing is never
  unlinked and nothing is scaled down for you. If spend runs away, stop SurrealDB (above) and look
  at the billing report. (The automatic stop was dropped on 2026-10-05: it needed an org-policy
  exception because of the org's domain-restricted sharing.)
- **Scale caps:** ResourceQuotas on the `database` and `external-secrets` namespaces, Cloud Run
  `max_instance_count = 2`, SurrealDB replicas validated to 0 or 1.

## Bootstrapping a new environment (e.g. prod)

`tf.sh` only knows the dev roots (`live/dev/<root>`), so these steps call `tofu -chdir=…` directly
with your own credentials. Set `R=infra/terraform/live/prod` first.

1. Copy `live/dev` to `live/prod` and change names/IDs, **without `encryption.tf`** (the keys don't
   exist yet). Let `google_project` **create** the project with `auto_create_network = false`
   (dev's was made by hand, so its open-by-default network had to be imported and destroyed).
2. First apply of `bootstrap` with local state: `mv $R/bootstrap/backend.tf $R/bootstrap/backend.tf.first-run`,
   then `tofu -chdir=$R/bootstrap init` and `tofu -chdir=$R/bootstrap apply` (this creates the
   bucket, the KMS keys and the CI identities).
3. Move the state into the new bucket: `mv $R/bootstrap/backend.tf.first-run $R/bootstrap/backend.tf`,
   then `tofu -chdir=$R/bootstrap init -migrate-state`.
4. Add `encryption.tf` with an `unencrypted` fallback (`state` and `plan` blocks with
   `fallback { method = method.unencrypted.migration }`), then
   `tofu -chdir=$R/bootstrap apply -refresh-only` writes the state encrypted. Check that
   `gcloud storage cat …/default.tfstate | jq 'keys'` shows `encrypted_data`, then remove the
   fallback and set `enforced = true`.
5. Apply `gcp` (services start on Google's placeholder image until `apps` has a build), then
   `cluster`, each with `encryption.tf` enforced from the start (a new state is written encrypted).
6. Before using `tf.sh` or CI for prod, teach `tf.sh` an environment (it is dev-only today) and add
   prod gates and environments.

## Lessons learned

- **`apply -refresh-only` can fail where `state pull`/`state push` won't.** Encrypting the images
  state (L3, 2026-10-22) failed with refresh-only because its data sources look up snapshot images
  for the current build hashes, which didn't exist; `state pull | state push` (same lineage, serial
  +1) rewrote it encrypted instead. Only for states without sensitive values (never bunny).
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
