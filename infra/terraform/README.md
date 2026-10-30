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
  bootstrap/   project, APIs, state bucket, KMS keys, CI identities (keyless), budget, Bunny account key secret, log bucket (London)
  org/         organisation-wide UK settings; postponed, no root calls it (D119, its README)
  gcp/         network, Artifact Registry, GKE Autopilot, secrets, backups, Cloud Run, dev-seed Job (dev)
  cluster/     inside GKE: External Secrets Operator, SurrealDB (Kustomize overlay), migrations
  db-migration/ the D14 migration bundle and Job name (no providers; `tofu test` offline)
  db-identity/ SurrealDB's identity config: init Secret names, restart hash, marker (same)
  bunny/       Bunny.net: Stream library, storage zone + pull zone, app keys in Secret Manager
  bunny-state-guard/ the bunny root's "never public" check (no providers; tested)
  stripe/      donations in Stripe: product, prices, Payment Links, donor portal (tested, mock provider)
live/dev/      one root per concern, applied in this order:
  bootstrap/   developer only, locally (billing roles)                  state: dev/bootstrap
  gcp/         tofu-apply.yml (approved) or a developer              state: dev/gcp
  images/      a developer (Docker), or tofu-apply.yml on request    state: dev/images
  cluster/     tofu-apply.yml (approved) or a developer              state: dev/cluster
  bunny/       tofu-apply.yml (approved, as tf-bunny) or a developer state: dev/bunny (private)
  stripe/      tofu-apply.yml (approved) or a developer, Stripe sandbox state: dev/stripe
```

State is in `gs://heisreal-dev-tfstate` (London, versioned, 30 days of old versions, 7 days of
soft delete, locked), encrypted with Cloud KMS ([Encryption](#encryption)). Roots read each
other's outputs through `terraform_remote_state`. **State holds no secrets:** passwords are
write-only and Google tokens are `ephemeral`, so keep it that way when adding resources. The one
approved exception is `bunny` ([below](#bunnynet)): nothing reads its state through
`terraform_remote_state`, and only developers and `tf-bunny` can read or decrypt it.

## Day to day

Log in with `gcloud auth login --update-adc` (your Workspace forces re-authentication now and
then) and `mise install` (OpenTofu at the `mise.toml` pin; `tf.sh` refuses any other version). Then run every root
through **`tools/scripts/tf.sh <root> <tofu args>`**:

| Command                                  | Does                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `tf.sh <root> init` / `plan` / `apply`   | `tofu -chdir=infra/terraform/live/dev/<root> …`; every `plan` also runs the UK location check (below)             |
| `tf.sh <root> plan-summary <planfile>`   | changed addresses, actions and a count only (what CI publishes; safe for bunny)                                   |
| `tf.sh <root> location-check <planfile>` | reports anything the plan puts outside the UK; warns in dev, fails elsewhere ("Where data lives"; safe for bunny) |
| `tf.sh bunny-cli <args>`                 | the bunny CLI with the account key from Secret Manager, for that one process                                      |
| `tf.sh bunny-mask secrets\|state`        | CI only: `::add-mask::` every Bunny key before tofu runs                                                          |

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
attributes being sensitive, every Kustomize overlay rendered and checked with kubeconform, and the
planner's dry-run-only policy on kind. `ci.yml`'s required job runs the modules' `tofu test`
(`terraform:test`, `infra/terraform/test-modules.sh`; locally `pnpm nx run terraform:test`) and the
database integration suite, so those block merges. Then the roots the PR
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
  waits for one approval in `dev`, then both apply their saved plans, **bunny first**: gcp applies
  once bunny applied or had no changes (bunny grants gcp's services access to keys they read at
  start-up, e.g. api-user's link-signing keys; a failed bunny plan or apply holds gcp back, and
  wave 2 with it, until a dispatched run; `tools/scripts/tests/tf-apply-order.test.mjs`). Wave 2: cluster (and images)
  plan **after** gcp's apply, against its fresh outputs; if either changes, `approve-2` asks once
  more. A single-root change asks once; gcp + cluster asks twice.
- **Each apply applies exactly its saved plan** (KMS-encrypted, in `gs://heisreal-dev-tfstate/plans/`,
  or `dev/bunny/plans/` for bunny; unapproved plans expire after 7 days). OpenTofu refuses it if
  state changed meanwhile.
- **Superseded runs.** If `main` moves while a run waits, its plan summaries say **"⚠ superseded by
  <sha>: reject this run; the next run plans again."** Reject it. Approving it applies nothing:
  the approve job re-checks `main` after the click. Then the `superseded` job warns "Superseded
  by run N: …" and fails on purpose, so the run is red rather than a green tick. Its summary
  names the roots that applied, failed or weren't applied (a failed or cancelled apply may have
  changed some resources, so it never says "nothing applied" then). If one failed, read that job's log;
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

| Identity                      | Used by                                                                  | Can reach                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| developers (`var.developers`) | people                                                                   | everything: project owners, `storage.admin` on the buckets, Token Creator on the CI identities, both KMS keys; organisation policies and log settings (granted by hand)                                      |
| `tf-planner`                  | any workflow in this repository (`tofu-plan.yml`, drift)                 | `roles/viewer`, `iam.securityReviewer`, read state (not `dev/bunny/`), `tofu-state`, bucket metadata; reads the organisation's policies and log settings. No secret values or backups                        |
| `tf-cluster-planner` (D42)    | `tofu-plan.yml` on PRs, in the `cluster-plan` environment                | the cluster's API (dry runs and reads in `database` only, see CI), read state (not `dev/bunny/`), `tofu-state`                                                                                               |
| `tf-deployer`                 | `tofu-apply.yml` and `tofu-drift.yml` on `main`                          | what the gcp, cluster, images and stripe roots manage; state (not `dev/bunny/`), `tofu-state`, saved plans in `plans/`; reads `stripe-api-key`. No `bunny-*` secrets, no `tofu-bunny`, no bucket IAM changes |
| `tf-bunny` (D57)              | `tofu-apply.yml` and `tofu-drift.yml` on `main`; developers              | the bunny root only: `dev/bunny/` (state, plans, logs), the `bunny-*` secrets, `tofu-bunny`; `iam.securityReviewer` for the never-public guard                                                               |
| `ci-image-pusher`             | `images.yml` on a push to `main`                                         | push to `apps`                                                                                                                                                                                               |
| `ci-snapshot-pusher`          | `snapshot-images.yml` (manual, any branch)                               | push to `apps-scratch`                                                                                                                                                                                       |
| `ci-dev-seeder` (D50)         | `reset-dev-data.yml`, `dev-behavioural-tests.yml` (dispatched on `main`) | run and watch the `dev-seed` Cloud Run Job only (granted on that Job by the gcp root): no overrides, no secrets, no logs                                                                                     |

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
`heisreal-dev-media` (video and audio), storage zone `heisreal-dev-image-store` (Standard tier,
London, S3-compatible, no replication) and pull zone `heisreal-dev-images`
(`heisreal-dev-images.b-cdn.net`, EU + US routing) in front of it. The storage zone isn't called
`-images` because Bunny still reserves that name from the first account, deleted on 2026-10-25;
the pull zone kept it, so the images CDN host didn't change. The library's own storage zone, where
its videos live (`vz-…`, made by Bunny with the library), is declared too and adopted with an
`import` block in `live/dev/bunny`: Bunny puts Stream storage in Frankfurt (`DE`, EU) and neither
its API nor the provider lets us choose, so it's written down to make where the videos live
visible and any change drift. No replication regions (they can't be removed again and cost extra),
and `prevent_destroy`, since destroying it deletes every video. No custom hostnames (D7).
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
copied into Secret Manager with write-only versions; apps read them through `libs/secrets`.
`bunny-stream-api-key` and `bunny-storage-password` (uploads) are read by api-user alone
(`upload_key_readers`, which accepts nothing but this project's api-user service account).
`bunny-stream-token-key` and `bunny-images-token-key` (D52) are read by api-public-read and
api-user (`signing_key_readers`). Each is a grant on one secret, made by this root.

**The never-public guard.** Before every plan the root reads the IAM policies of the state bucket,
the project, the `tofu` keyring and both keys, and every `bunny-*` secret, and refuses to plan if
`allUsers` or `allAuthenticatedUsers` holds any role on any of them (`modules/bunny-state-guard`,
tested offline). Organisation-level checks are in `tools/scripts/check-bunny-fences.sh` (below);
`tf-bunny` has no organisation permission.

**Running it.** `tools/scripts/tf.sh bunny <command>` runs as `tf-bunny` by default, from any
branch. `tf.sh bunny-cli <args>` runs the bunny CLI with the account key in `BUNNYNET_API_KEY` for
that one process, so you never need `bunny login`, a profile or a `.env` file.

**In CI (public logs).** Bunny jobs mask every `bunny-*` secret before any tofu step, and the five
keys from state (the five sensitive attributes and the Stream pull zone's key) right after `init` (`tf.sh bunny-mask`). Masking is a backstop (it misses encoded
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

**Uploads (M2; services never handle media bytes, as in the prototype).** Both direct uploads
are **proven on dev** (2026-10-29): a real browser at web's dev origin uploads a 2-second clip by
TUS and a ~20 KB WebP by presigned PUT, with links signed the way api-user will sign them
(`apps/dev-seed/behavioural/upload-signing.ts`), checks they arrived and deletes them. Run it again
with `pnpm nx run dev-seed:upload-spike` (your gcloud ADC and ffmpeg; it reads the two upload
keys, so a developer runs it, not CI). It leaves nothing behind.

- **Video and audio (Stream TUS).** api-user creates the video (`POST
video.bunnycdn.com/library/{libraryId}/videos` with the library key; the title is the story id
  only, D69) and returns `libraryId`, `videoId`, `expirationTime` and
  `signature = sha256(libraryId + libraryKey + expirationTime + videoId)` (hex). The browser
  POSTs to `https://video.bunnycdn.com/tusupload` with those as the `LibraryId`, `VideoId`,
  `AuthorizationExpire` and `AuthorizationSignature` headers, reads `Location` and PATCHes the
  bytes there. A wrong signature or a moved expiry answers 401, a past expiry 400. Bunny's CORS
  lets web's origin send these headers and read `Location`. **Lands in Frankfurt** (the library's
  storage zone, D89), encoded by Bunny.
- **Images (S3 presigned PUT).** api-user signs a SigV4 query-string URL for
  `https://uk-s3.storage.bunnycdn.com/heisreal-dev-image-store/<key>`: access key = zone name,
  secret = `bunny-storage-password`, SigV4 region `uk`, `UNSIGNED-PAYLOAD`, and the signed
  headers `content-type`, `content-length` and `if-none-match: *`. The browser PUTs with
  `Content-Type` and `If-None-Match: *` (it sets `Content-Length` itself). **Lands in London**
  (the zone's only region, no replication).

What each presigned link enforces itself, and what api-user must check before it signs (D113,
Joel 2026-10-28: "the main concern here is people spamming our video storage with tons of videos
and spiking cloud costs"):

| Bound         | Image (S3 PUT)                                                                                                                                                                                                                         | Video/audio (TUS)                                                                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where it goes | the key api-user picked (another key: 403)                                                                                                                                                                                             | the video api-user created (another: 401)                                                                                                                                             |
| Size          | exact `Content-Length` (anything else: 403)                                                                                                                                                                                            | **not bound**: known only after upload, from Bunny's encoding result (D68)                                                                                                            |
| Type          | exact `Content-Type` as declared (403 otherwise); the bytes aren't checked, so processing checks the real content                                                                                                                      | **not bound**: junk ends as an encoding failure, refused at submit (D68)                                                                                                              |
| Expiry        | `X-Amz-Expires`, a few minutes (expired: 403; Bunny refuses over 7 days, 400)                                                                                                                                                          | `AuthorizationExpire` (past: 400, moved: 401); about an hour (D68)                                                                                                                    |
| One use       | yes: a second PUT with the same link answers 412 (`If-None-Match: *` is signed; without it, a PUT is refused 403)                                                                                                                      | **no**: an unexpired signature can upload again to the same video (D68)                                                                                                               |
| Per account   | **api-user, before signing**: the draft is the person's and still a draft (D80), and #118's limits model (admin-adjustable `submissionSettings`: 3 open drafts, 10 upload requests an hour, 1 submission a week; per-person overrides) | the same; and the video PR should keep **one video per draft item** (api-user reuses or deletes the draft's video before creating another), so repeated requests can't pile up videos |

Two things the spike found for later PRs: deleting a folder's last object by S3 leaves the empty
folder behind (Bunny's storage keeps it), so deletions (erasure, D82) also delete the story's
folder through the Edge Storage API (`DELETE https://uk.storage.bunnycdn.com/<zone>/<folder>/`);
and Playwright can't load `libs/secrets` (a Nest provider), so the spike reads the two keys with
the Secret Manager client directly.

**Media token auth (D52, M1 step 5).** Bunny refuses every media link without a valid `token`
and `expires` (403): the Stream player (`view_token_authentication_required`), Stream's CDN files,
HLS and thumbnails included (`cdn_token_authentication_required`; the player signs its own HLS
requests), and the images pull zone (`token_auth_enabled`, no IP binding). Unpublished media is
therefore unreachable: nobody issues links for it. The Stream key is the Stream pull zone's token
auth key (read with `data.bunnynet_pullzone.stream`; it signs both embed and CDN tokens); the
images key is the `images` zone's. api-public-read signs links for published stories, valid 6–7
hours (`apps/api-public-read/src/app/media`). Each switch is in `token_auth` (live root), so one
can be turned off on its own if Bunny's player ever stops signing its HLS requests. In M2, api-user
signs short-lived links for the person's own drafts with the same keys.

Rollout, in order (a revision that can't read its keys doesn't start):

1. Merge the PR. `tofu-apply.yml` wave 1 applies `bunny` (token auth on, the two key secrets and
   api-public-read's access) and `gcp` (the new images; signing still off, so media URLs stay
   `null` as before). Turning token auth on breaks nothing: no page used media links yet.
2. A follow-up PR sets `api_public_read_media` in `live/dev/gcp/main.tf` (values from
   `tf.sh bunny output bunny`: `stream_library_id`, `stream_cdn_hostname`, `images_cdn_hostname`).
   Its gcp apply restarts api-public-read with signing on.
3. Run "Dev behavioural tests": `media.behaviour.ts` checks signed links load and unsigned or
   tampered ones get 403.

The player's controls are made 44 × 44 px (AGENTS.md touch targets) by CSS in the library's
custom head (`player_custom_head`, `modules/bunny/player-head.html`; plain CSS, no script, checked
by the module's tftest). It targets the player's media-chrome element names, so a Bunny player
update could undo it: the behavioural media checks measure the real player on a 320 px phone.
The player's other settings (key colour, font, captions, controls) match the site theme; what
each is for: `docs/media-runbook.md`, "The Stream player".

Rotating a token key: reset it at Bunny, apply bunny (new secret version), then start a new
api-public-read revision (keys are read at startup). Links signed with the old key stop working
at once.

### Site assets

Files that are part of the site itself (not stories) have their own place at Bunny:

- **Videos** go in the `site-assets` collection of the media library (`bunnynet_stream_collection.site_assets`
  in `modules/bunny`). Same library, so the same player, encoding and signed links as stories. Story videos
  never go in it.
- **Other files** (images and the like) go under the `site-assets/` path in the images storage zone. Folders at
  Bunny exist only as part of a file's path, so this is a naming rule, not a resource. They're served by the
  same signed pull zone.

**Add or replace a site video (dev):**

1. Upload it, with your own gcloud login (it reads `bunny-stream-api-key` from Secret Manager and never prints it):

   ```bash
   node tools/scripts/site-asset-upload.mjs ~/Downloads/HeIsReal-site-assets/<file>.mp4 \
     --title "The heart behind He Is Real" \
     --description "Stephen Linnecar, our founder, introduces He Is Real for anyone asking “Is God real?”: honest, personal stories, Next Steps, and an invitation to share your own story."
   ```

   Running it again uploads nothing if the collection already has a video with that exact title; it prints the
   video's GUID and whether Bunny has finished encoding it. It works on dev only (`--env`, `ENVIRONMENTS` in the
   script); add prod there when prod exists.

2. Put the GUID in `live/dev/gcp/main.tf` under its key in `site_videos`. Apply gcp: api-public-read gets
   `SITE_VIDEO_<KEY>`, and the page plays it (`GET /v1/site-videos/<key>`, a signed 6–7 hour link). Until then, or
   if api-public-read is down, the page shows "Video coming soon".

| Key             | Page       | Title at Bunny              | api-public-read gets       |
| --------------- | ---------- | --------------------------- | -------------------------- |
| `founder-intro` | About      | The heart behind He Is Real | `SITE_VIDEO_FOUNDER_INTRO` |
| `next-steps`    | Next Steps | Next steps with He Is Real  | `SITE_VIDEO_NEXT_STEPS`    |

A new kind of site video needs a key in five places: api-public-read's `SITE_VIDEO_KEYS`, the allowed keys of
`site_videos` in `modules/gcp` (and its test), `SiteVideoKey` in the contract and in `apps/web/src/lib/site-videos.ts`,
and the e2e stub (`apps/web/e2e/stub-api.mjs`). The page shows it with `SiteVideo`
(`apps/web/src/components/page/site-video.tsx`). api-public-read signs only those keys, so nobody can ask it to sign
any other video.

**Cost:** Bunny bills at least $1 a month per account; dev usage (a few test files) stays under
it. Storage is $0.01/GB/month (Standard, one region), CDN $0.01/GB in EU/US, free encoding.

## Stripe

Donations (Joel, 2026-10-29: Stripe's embeddable Buy Buttons, option A, replacing the custom
payment form in `project/context/research/donation-integration.md`). Stripe hosts every payment
page; no card data and no donor data reach our services, and there is no webhook yet (api-user's
comes with M4). **Dev is Stripe's sandbox only** (account `acct_1UUWPqQXwDT04lZZ`, "He is Real
Today sandbox"): no real money.

`live/dev/stripe` (module `modules/stripe`, Stripe's own provider `stripe/stripe`) makes:

| Object                           | What donors get                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| product "Donation to He Is Real" | the name on Stripe's page and receipt                                                                                                   |
| one-off price + Payment Link     | GBP, "customer chooses price" from £1, starting at £10; the button says Donate (`submit_type = "donate"`)                               |
| monthly price + Payment Link     | £1 a month, and the donor chooses the quantity (1–999), starting at 10: 10 = £10 a month. A note beside Stripe's pay button explains it |
| donor portal configuration       | a login page (by email) where monthly donors change the quantity, update the card, see receipts or stop at the end of the paid month    |

Stripe can't let donors type a monthly amount: "customer chooses price" works for one-off
payments only, hence the £1 unit. Receipts are Stripe's own emails; card, Google Pay, Apple Pay
(through Stripe) and Link come from the account's payment method settings. Gift Aid isn't
collected yet (charity registration is pending); see "Later" below.

**The key.** The provider runs with a restricted key read from Secret Manager (`stripe-api-key`,
container from the bootstrap root, readable by tf-deployer only) through an `ephemeral` read, so
it's in neither state nor plans; the state holds Stripe IDs and public URLs only. The module
refuses to plan with a live key in dev (`sk_live_`/`rk_live_`; only the key's mode is checked,
never printed). CI masks the key before any tofu step (`tf.sh stripe-mask`). PRs never plan
stripe (tf-planner can't read the key); `tofu-apply.yml` plans it on `main` in wave 1, beside gcp
and bunny, under the same approval, and `tofu-drift.yml` checks it weekly.

**The buttons.** Stripe has no API for Buy Buttons, so they're made once in the Dashboard from
the Payment Links. Only their public IDs and the publishable key reach the site, through
`web_donations` in `live/dev/gcp` (web's `STRIPE_*` settings). /donate shows a "One-off |
Monthly" choice and only the chosen button (`?frequency=monthly` links straight to Monthly);
an option whose button isn't set is hidden, and with neither set the page keeps its "Giving
isn't open yet" placeholder. Stripe's script (`js.stripe.com`) loads on /donate only. The site
sends no Content-Security-Policy yet; when one comes, it needs `script-src` and `frame-src`
`https://js.stripe.com`.

| Task (owner: Joel)              | How                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First setup: the key (once)     | apply `bootstrap` (the secret container and tf-deployer's read). In the Dashboard, **in the sandbox**, Developers → API keys → Create restricted key with **Write** on Products, Prices, Payment Links and Customer portal (nothing else), then: `read -rsp 'Stripe key: ' k && printf %s "$k" \| gcloud secrets versions add stripe-api-key --project heisreal-dev --data-file=- && unset k` |
| First setup: the objects        | let `tofu-apply.yml` plan and apply `stripe` (or `tf.sh stripe apply`), then `tools/scripts/tf.sh stripe output stripe` for the two Payment Links and the portal URL                                                                                                                                                                                                                          |
| First setup: the buttons (once) | Dashboard (sandbox) → Payment Links → open each link → **Buy button** → Copy code. From each snippet keep `buy-button-id` (and the `publishable-key`, the same in both), put them and the portal URL in `web_donations` in `live/dev/gcp/main.tf`, and apply gcp                                                                                                                              |
| Rotate the key                  | create a new restricted key as above, add it as a new version (same command), roll the old one in the Dashboard                                                                                                                                                                                                                                                                               |

**The donor portal sets no `products` (provider bug).** Stripe's provider 0.3.0 never asks Stripe
to include the portal's `features.subscription_update.products` (Stripe leaves that field out
unless asked), so an apply that sets it always ends "Provider produced inconsistent result after
apply" and taints the portal (stripe/terraform-provider-stripe#53 and #54, open). So
`modules/stripe` leaves `products` out. **Dev keeps its stored products (1–999)**: its portal
(`bpc_1UWDW6QXwDT04lZZmPiB1gcP`, the account's default) got them from the first apply, which set
them before failing; OpenTofu doesn't see or change them. **A portal created without them** (a new
environment, or a replacement) **probably only allows cancel, card and receipts, not changing the
amount**: Stripe applies `default_allowed_updates` to the items listed in `products` ("When
empty, subscriptions are not updateable"). Once a provider release expands the field, put
`products` back (the limits `var.monthly` gives) and plan: it converges everywhere.

**Clearing the first apply's taint (dev, once).** The portal exists in Stripe but its state is
tainted, so every `tofu-apply.yml` run plans to deactivate it (it's the account's default) and
make another (`delete,create`), under wave 1's shared approval (approve-1).

1. Run `tools/scripts/tf.sh stripe untaint module.stripe.stripe_billing_portal_configuration.donors`
   **before** merging the fix, or before approving any `tofu-apply.yml` run.
2. If a run has already planned the portal's `delete,create`, reject it, untaint, then dispatch
   `tofu-apply.yml` and check that the stripe plan says "No changes".

`modules/stripe/tests/link-lifecycle.sh` checks both cases (untainted: no change; tainted:
`delete,create`). Nothing to clean up in Stripe: there is one portal configuration.

**Changing an amount** (the one-off minimum or starting amount, or the monthly unit) makes a new
price, since Stripe's prices can't change, and so a **new Payment Link**: a link's price can't be
swapped in place (`replace_triggered_by` in `modules/stripe`; tested offline by
`modules/stripe/tests/link-lifecycle.sh`). A new link needs a **new Buy Button** (owner step,
Dashboard), whose ID then goes into `web_donations`. The apply makes the new price and link first,
then deactivates the old link and archives the old price, so **the old button stops working at
that apply** until gcp applies the new ID. Either:

- do it in one sitting: approve the stripe apply, make the new button, update `web_donations`
  and apply gcp straight away (the gap is those few minutes); or
- for no gap: before the run that plans the change, let OpenTofu forget the old ones so they stay
  live (`tools/scripts/tf.sh stripe state rm module.stripe.stripe_payment_link.one_off
module.stripe.stripe_price.one_off`, or the `monthly` pair). The apply then only creates the new
  price and link. Switch `web_donations` to the new button, apply gcp, then archive the old link
  and price in the Dashboard.

Anything deactivated or archived in the Dashboard (a link, a price, the product, the portal) is
drift: OpenTofu pins `active = true`, so the next plan turns it back on.

**Going live (not now).** A production environment gets its own root with `live = true` in the
module (it then refuses a sandbox key), a restricted **live** key in its own project's
`stripe-api-key`, buttons made in live mode and a `pk_live_` key in its `web_donations` (dev's
`web_donations` refuses `pk_live_`). Before that: the charity registration, Gift Aid (below),
the privacy text, and Stripe's live-mode payment method and receipt settings, all for Joel; and
**a provider release that reads back the portal's `products`** (above), with `products` restored:
a new live portal would otherwise probably not let donors change the amount, which /donate's
"change or stop it at any time" and `apps/web/src/lib/config.ts`'s donor portal promise.

**Later: Gift Aid.** Once He Is Real Today is a registered charity: either collect the Gift Aid
declaration in Stripe (a Payment Link custom field "I am a UK taxpayer…" plus
`billing_address_collection = "required"` for the home address HMRC needs, and claim from the
exported payments), or a service such as Swiftaid that collects and claims it. Not built.

## Where data lives (D101–D104, D119)

Joel's rule: data stays in the UK wherever possible, written explicitly in OpenTofu, never left to
a provider's default. Every Google Cloud resource we create names `europe-west2` (London). While
the organisation-wide enforcement below waits for launch (D119; Joel, 2026-10-30: "org setup
should happen at launch … regional restrictions – which I am not concerned with in dev, I don't
want this to slow us down right now"), two cheap checks in this repository stand in for it (the
interim guard). **In dev the guard warns and never blocks; in any other environment it blocks.**

1. **Variables accept only the UK.** Every module variable that sets a place refuses anything
   other than London (or Bunny's `UK`), in every environment: a one-line config mistake, so a wrong
   value fails `tofu validate`, `tofu test` and every plan: `region` in `gcp`,
   `bootstrap` and `bunny` (`europe-west2`), bunny's `storage_region` (`UK`, Bunny's London), and
   `modules/org`'s `log_storage_location` (`europe-west2`) and `allowed_locations` (UK values only).
2. **Every plan is checked** (`tools/scripts/tf-location-check.sh`, run by `tf.sh <root> plan` for
   every root: PR plans, `tofu-apply.yml` before approval, the weekly drift job and local plans,
   bootstrap's included), for the root's environment, taken from its path (`live/<environment>/`)
   so it can't be forgotten. It reports a resource the plan creates or updates that has a `location`,
   `region` or `zone` (any case, at any depth; on Google resources also names built on them, such
   as Firestore's `location_id`, GKE's `node_locations` or a bucket's `data_locations`) other than
   `europe-west2`, `europe-west2-a/b/c` or `EUROPE-WEST2`, or one known only after apply (a
   container of locations too, such as a secret's replicas); a Spanner instance whose `config`
   isn't `regional-europe-west2`; a Pub/Sub topic whose
   `message_storage_policy.allowed_persistence_regions` isn't exactly `["europe-west2"]`; or a
   secret with automatic (global) replication, or one that may get it (known only after apply).
   Names that look like places but aren't (time zones, DNS zones, Cloud Storage paths such as
   `source_location`) are listed in the script. Exceptions are listed in the script, each with its
   reason: genuinely global types (IAM, service accounts, project services, the VPC network and
   firewall, the budget, Workload Identity, the log sink, quota settings), never checked; and
   Bunny's own region names (`UK` for images; `DE` only for Stream's storage zone, D89; no
   replication). It prints only resource addresses, attribute paths and the offending locations,
   so it also runs on bunny's plans. **In dev** a finding is a `location-check: WARNING` line in
   the log and the job's step summary, and the plan or deploy goes on with tofu's own exit code.
   **Anywhere else** (prod at launch) it fails the plan (exit 1), so it never reaches an
   approval. Clerk (US, D6) isn't in OpenTofu, so neither check sees it.

Tip: applying a saved plan (`tf.sh <root> plan -out=f`, then `tf.sh <root> apply f`) applies
exactly what was checked.

| Data                                                    | Where                                     | Declared in                              |
| ------------------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| SurrealDB (GKE disk), backups, OpenTofu state, KMS keys | London                                    | `gcp`, `bootstrap`                       |
| Cloud Run services and jobs, Artifact Registry images   | London                                    | `gcp`                                    |
| Secrets (Secret Manager)                                | London only (user-managed replication)    | `gcp`, `bootstrap`, `bunny`              |
| Our services' logs (`_Default` sink, 30 days, D101)     | London (`default-europe-west2`)           | `modules/bootstrap/logging.tf`           |
| Google's audit logs (`_Required`, 400 days, D104)       | `global` (dev can't move; D119 postponed) | `modules/org`, not called yet (D119)     |
| Images (Bunny storage)                                  | London                                    | `bunny`                                  |
| Story videos and audio (Bunny Stream, D89)              | Frankfurt (Bunny's only choice)           | `bunny`                                  |
| Bunny's CDN caches (D103)                               | EU + US edges (images), worldwide (video) | Bunny's defaults; revisit for production |

**Logs (D101).** Google creates each project's `_Default` and `_Required` log buckets in `global`,
and a bucket's location is fixed when it's created. So `bootstrap` adds a London bucket and points
the existing `_Default` sink at it (imported, filter unchanged, deletion refused). The old global
`_Default` bucket stays, empty after 30 days; Logs Explorer's project scope reads both.
**Dev's `_Required` bucket stays `global`**: Google can't move, delete or redirect it, so only
recreating the project would put it in London (D104).

**Organisation settings (D102, D104; `modules/org`): postponed (D119, Joel, 2026-10-30).** They
need organisation roles that only the organisation admin can grant, and that one-time setup
hasn't been done, so `live/dev/bootstrap` no longer calls the module and a plain
`tf.sh bootstrap plan` works with a developer's own login. Until the setup is done:

- nothing at organisation level refuses a resource outside the UK, and in dev the interim guard
  above only warns. It sees what OpenTofu declares, but not something made outside OpenTofu, or
  a resource that is regional by default without a location attribute; read any warning in a
  plan's step summary, and glance at new resources' locations;
- a project created now gets its `_Required` audit-log bucket in `global` for good.

**Gate:** the organisation admin's setup and turning `modules/org` back on (its README has the
steps) come before Go live and before a prod project is created. When on, the module sets, for
every project in `heisreal.today` (so only one root may call it, and a prod bootstrap must not):

- **Default log location `europe-west2`**: new projects get their `_Default` and `_Required` buckets
  in London. Existing buckets keep theirs. The settings are imported, with the other two fields
  declared as they are (`_Default` sink on, no CMEK), because the provider rewrites all three.
- **`constraints/gcp.resourceLocations` = `in:gb-locations`** (the UK: today `europe-west2` and
  its zones; Google adds new UK locations to the group): creating a location-bound resource
  elsewhere fails. It checks new resources, including the VMs GKE creates when it scales, and
  some services check updates too; nothing in dev conflicts. Global resources (service accounts,
  Workload Identity, the VPC network, routes, firewalls, Cloud DNS, Pub/Sub topics, budgets)
  aren't location-bound. Secret Manager's automatic replication is refused (it's `global`), so
  secrets keep user-managed London replication. Topics created after the policy store messages
  in the UK; still declare `message_storage_policy` on M2's topics. No exception is needed.

**Before `modules/org` is turned back on**, the organisation admin (`info@heisreal.today`) runs this once, in Cloud
Shell or a terminal signed in as that account. Nobody who runs OpenTofu can change organisation
access, and the org admin role can't create roles itself, hence the first line:

```bash
ORG=463617123121
gcloud organizations add-iam-policy-binding $ORG --member=user:info@heisreal.today --role=roles/iam.organizationRoleAdmin --condition=None
gcloud iam roles create logSettingsAdmin --organization=$ORG --title="Log settings admin" --permissions=logging.settings.get,logging.settings.update
gcloud iam roles create orgSettingsReader --organization=$ORG --title="Org settings reader" --permissions=logging.settings.get,orgpolicy.policy.get
gcloud organizations add-iam-policy-binding $ORG --member=user:joel@heisreal.today --role=organizations/$ORG/roles/logSettingsAdmin --condition=None
gcloud organizations add-iam-policy-binding $ORG --member=user:joel@heisreal.today --role=roles/orgpolicy.policyAdmin --condition=None
gcloud organizations add-iam-policy-binding $ORG --member=serviceAccount:tf-planner@heisreal-dev.iam.gserviceaccount.com --role=organizations/$ORG/roles/orgSettingsReader --condition=None
```

Developers apply bootstrap (`orgpolicy.policyAdmin`: custom roles can't set policies; the log
settings role holds only the two settings permissions). The organisation grant gives `tf-planner`
only those two reads and no log-entry access (any workflow in this repository, PRs included, can
use it). Its existing project-level Viewer role in dev still lets it read dev's own logs. The
grants must exist before the module goes back into bootstrap, or bootstrap's plan fails on
importing the log settings (and so does `tofu-drift.yml`).

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

0. Turn the organisation settings back on first ([Where data lives](#where-data-lives-d101d104-d119),
   D119): a project's audit-log bucket takes the organisation's default location when the
   project is created and never moves.
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
