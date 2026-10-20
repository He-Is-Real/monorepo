# SurrealDB on Kubernetes

Single-node SurrealDB **v3.2.4** on RocksDB with a persistent disk, packaged with Kustomize
("Option A" in the project doc `context/research/surrealdb-kubernetes-options.html`, which also
explains the Kubernetes terms used here).

```
base/                     shared by every environment
  statefulset.yaml        1 pod + disk; never more than 1 (RocksDB is single-writer);
                          fsync on every commit (SURREAL_DATASTORE_SYNC_DATA=every)
  service.yaml            internal name surrealdb.database.svc; never public
  networkpolicy.yaml      deny all inbound, except pods in this namespace labelled
                          heisreal.today/db-client=true (the init, migrate and backup Jobs)
  init-users-job.yaml     namespace/database, system users, service logins (re-runnable)
  init.surql.tmpl         what it runs; passwords filled in from Secret Manager
  migrate-job.yaml        schema migrations (D14); a template, see "Schema migrations"
  backup-cronjob.yaml     nightly `surreal export` → Cloud Storage
overlays/local/           kind/k3d/minikube: 1 GiB disk, no backups
overlays/gke/             External Secrets Operator, Workload Identity, SSD disk
overlays/gke-dev/         dev values (settings.env, checked against Terraform), Spot Pods, small
                          requests, 5 GiB balanced disk, Cloud Run subnet allowed in, quota
scripts/local-secrets.mjs creates a local cluster's Secrets from the dev project via gcloud
scripts/local-migration.mjs creates a local cluster's migration bundle (ConfigMap)
```

## Database users

Since D13 B, services sign in as `service` records through `DEFINE ACCESS svc`, and the schema's
table and field permissions limit each one ([docs/db-permissions.md](../../../docs/db-permissions.md)).
Only the in-cluster Jobs are system users. Each identity has its own Secret Manager secret:

| Identity                  | Kind / role        | Secret                             | Used by                               |
| ------------------------- | ------------------ | ---------------------------------- | ------------------------------------- |
| `service:api_public_read` | service login      | `surreal-api-public-read-password` | api-public-read                       |
| `service:api_user`        | service login      | `surreal-api-user-password`        | api-user                              |
| `service:api_admin`       | service login      | `surreal-api-admin-password`       | api-admin                             |
| `service:workflow`        | service login      | `surreal-workflow-password`        | workflow (M7)                         |
| `backup`                  | system user VIEWER | `surreal-backup-password`          | backup CronJob                        |
| `migrator`                | system user OWNER  | `surreal-migrator-password`        | migrate Job only                      |
| `root`                    | root OWNER         | `surreal-root-password`            | init Job only (and the SurrealDB pod) |

The init Job (as root) defines `migrator` and `backup`, **removes** the old per-service system
users (`api_read`, `api_write`, `api_admin`, `workflow`: an EDITOR could `REMOVE EVENT`), and
writes each service's argon2 hash with `crypto::argon2::generate`, so only the hash is stored.
The plaintext stays in the `surrealdb-init` Secret (rendered in-cluster by ESO): never in
Terraform state, the repo, the migration bundle or logs.

Checked against a real 3.2.4 server: VIEWER can't create records and a VIEWER export equals a
root export (backups need no write access). Exports include the password and secret hashes; the
passwords are 40 random characters, so the hashes aren't crackable in practice.

## Run it locally

You need a local cluster (kind, k3d or minikube), `kubectl`, and `gcloud` logged in to
`heisreal-dev`.

```bash
node infra/k8s/surrealdb/scripts/local-secrets.mjs --project heisreal-dev   # local clusters only
node infra/k8s/surrealdb/scripts/local-migration.mjs                       # the schema bundle
kubectl apply -k infra/k8s/surrealdb/overlays/local
kubectl -n database rollout status statefulset/surrealdb
kubectl -n database wait --for=condition=complete job/surrealdb-init-users --timeout=180s
kubectl -n database wait --for=condition=complete job/surrealdb-migrate --timeout=600s
kubectl -n database port-forward svc/surrealdb 8000:8000   # apps use ws://localhost:8000
```

- Stop/start without deleting anything: `pnpm nx run surrealdb-k8s:local-down` / `local-up`.
- The first one or two init Job runs fail with a DNS error: `surrealdb` only resolves once the pod
  is ready, and the Job retries until then.
- After passwords are rotated, re-run `local-secrets.mjs`, delete `job/surrealdb-init-users` and
  re-apply the overlay (for root, see "Rotating passwords" first).
- After a schema change, re-run `local-migration.mjs` (it deletes the old migrate Job) and
  re-apply the overlay. `--clerk-public-key-file <pem>` turns on person sessions.

## Deploy to GKE (Terraform only)

Never `kubectl apply` to GKE. The `cluster` root applies the `gke-dev` overlay; the `gcp` root
owns the cluster, secrets, bucket and identities (see [the Terraform README](../../terraform/README.md)).
Cloud Run reaches SurrealDB at `surrealdb.database.svc.cluster.heisreal-dev.internal:8000`
through VPC-scope DNS, with no load balancer.

`settings.env` repeats a few Terraform values (project, bucket, service accounts, Cloud Run
subnet) so the overlay renders on its own; the `cluster` root refuses to plan if they differ.

Set `storageClassName` and the disk size **before the first deploy**: a StatefulSet can't change
them afterwards (disks can be grown by editing the PVC).

## Schema migrations (D14)

`libs/database/schema` is the bundle: `schema.surql` (declarative, applied in full every time),
`access-clerk.surql`, numbered `data/NNNN-*.surql` scripts (each runs once), `dpa-sync.surql`
and the runner, `migrate.py` (its header has the details). On GKE the `cluster` root ships it as
the ConfigMap `surrealdb-migration-<hash>` and runs the Job `surrealdb-migrate-<hash>` as
`migrator`. The hash covers every file, the Terraform parameters (DPA hashes, Clerk key) and the
Job spec: change any of them and the next apply replaces the Job, which runs; change nothing and
there's no diff. Each step is one transaction, so a failure keeps nothing from that step.

The runner uses the `google/cloud-sdk` image (already pinned for backups): the SurrealDB image has
no shell, and `surreal import` requires `OPTION IMPORT`, which switches off events and field
rules, so data scripts would bypass the schema.

**Order: migrate, then deploy.** The schema must accept both the running and the new service
code; a breaking change is split over two releases.

1. Merge. Apply the `cluster` root (`terraform -chdir=infra/terraform/live/dev/cluster apply`);
   the plan shows the new `surrealdb-migrate-<hash>` Job and ConfigMap.
2. Check it (read-only):

   ```bash
   JOB=$(terraform -chdir=infra/terraform/live/dev/cluster output -raw migrate_job)
   kubectl -n database wait --for=condition=complete "job/$JOB" --timeout=15m
   kubectl -n database logs "job/$JOB"   # ends with MIGRATION SUMMARY {...}
   ```

   The summary lists what was `applied`, `alreadyApplied` and `heldBack`. The Job only completes
   once the init Job's work is visible: system users exactly `backup` and `migrator`, and a login
   for every service.

3. Then apply `gcp` to deploy the services that need the new schema.

**If it fails**, `kubectl -n database logs job/<name>` (and `describe job/<name>`) says which step
and why; nothing from the failed step was kept (earlier data scripts stay applied). Fix it in a PR
(never edit a data script that has already run anywhere: add a new one) and apply again: the
fixed bundle has a new hash, so a new Job runs. To re-run the same bundle (for example after a
Spot reclaim), apply with `-replace='module.cluster.kustomization_resource.migrate'`. The previous
schema stays in force meanwhile, so don't deploy code that needs the new one.

**Adding a data script:** `libs/database/schema/data/NNNN-what-it-does.surql`, next number,
plain statements (no `BEGIN`/`COMMIT` and no top-level `RETURN`: the runner wraps each script
in its own transaction and records it in `_migration` with a checksum). Add tests in
`libs/database/integration`. A script that uses a parameter Terraform passes as null (e.g.
`$legacy_sha256` while `libs/legal/dpa/legacy-squarespace.md` doesn't exist) is **held back**,
with every later script, until it's set; the plan warns about it. Today 0002 (D22) is held back
until the legacy DPA text exists.

**Clerk key** (task 0.5): put Clerk's PEM public key in
`infra/terraform/live/dev/cluster/clerk.auto.tfvars` and apply. Until then the migration removes
`DEFINE ACCESS clerk`, so no token can open a person session. Never a private key (the variable
refuses one).

**DPA text** (D20): Terraform passes each `libs/legal/dpa/*.md` file's sha256. While a version is a
draft, its `contentHash` follows the file; once published, a changed file fails the migration.

**First apply of this (one-time switch to service logins).** The services' new secrets must
exist before the cluster renders them, and the deployed api-public-read still signs in as the
old `api_read` user until it's redeployed:

1. Wait for "Release Images" to build `main` (libs/database now signs in through `svc`).
2. `gcp`: `terraform apply -target='module.gcp.google_secret_manager_secret_version.surreal' -target='module.gcp.google_secret_manager_secret_iam_member.surrealdb_secrets'`
   creates `surreal-api-public-read-password` and `surreal-api-user-password` and gives ESO
   access.
3. `cluster`: apply and check the Job as above. The old system users are gone from here on, so
   dev's api-public-read can't sign in until step 4.
4. `gcp`: a full apply deploys api-public-read with its service login and deletes the two old
   secrets.

## Backups and restore

The CronJob runs at 02:30 UTC: it exports `heisreal/main` as `backup` and uploads
`gs://<bucket>/surrealdb/heisreal-main-<timestamp>.surql` with a create-only PUT (the job can't
read or overwrite earlier backups). Backups are Article 9 data: UK bucket, readable only by
developers, deleted after 30 days, part of the GDPR erasure/retention map.

- **Back up now:** GKE: `terraform -chdir=infra/terraform/live/dev/cluster apply -var backup_run=<new id>`.
  Locally: `kubectl -n database create job --from=cronjob/surrealdb-backup backup-manual`.
- **Restore drill** (`stack-decisions.md` requires a tested restore; last done on GKE 2026-10-05).
  Restore into a scratch database, check it, then remove it:

  ```bash
  gcloud storage cp gs://heisreal-dev-db-backups/surrealdb/<file>.surql restore.surql
  kubectl -n database port-forward svc/surrealdb 8000:8000
  export SURREAL_PASS="$(gcloud secrets versions access latest --secret=surreal-root-password --project=heisreal-dev)"
  surreal import --endpoint http://localhost:8000 --username root --namespace heisreal --database restore_drill restore.surql
  echo 'INFO FOR DB;' | surreal sql --endpoint http://localhost:8000 --username root --namespace heisreal --database restore_drill
  echo 'REMOVE DATABASE restore_drill;' | surreal sql --endpoint http://localhost:8000 --username root --namespace heisreal --database main
  unset SURREAL_PASS; rm restore.surql
  ```

Always export to a **file**: on stdout the CLI mixes its log lines into the dump.

## Rotating passwords

Terraform generates the passwords (`infra/terraform/modules/gcp/secrets.tf`, write-only).
Rotating adds a new Secret Manager version and leaves the previous one in place.

- **Services, migrator and backup:** bump `secret_rotation` in the gcp root and apply. ESO syncs
  within an hour (annotate the ExternalSecret `surrealdb-init` with `force-sync=$(date +%s)` to
  hurry it). Then apply the cluster root: the init Job is recreated on every apply (once the
  previous one is 10 minutes old) and writes the new service hashes and system-user passwords.
  Finally restart the services, which read their secret at startup.
- **Root:** SurrealDB only reads the root password on _first_ start, so tell the running database.
  Bump `root_secret_rotation` in the gcp root and apply, then sign in with the previous version
  and set the new one (port-forward as above):

  ```bash
  NEW=$(gcloud secrets versions access latest --secret=surreal-root-password --project=heisreal-dev)
  export SURREAL_PASS=$(gcloud secrets versions access <previous> --secret=surreal-root-password --project=heisreal-dev)
  printf 'DEFINE USER OVERWRITE root ON ROOT PASSWORD %s ROLES OWNER;\n' "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$NEW")" \
    | surreal sql --endpoint http://localhost:8000 --username root
  unset SURREAL_PASS NEW
  ```

  Skip this and the init Job fails with "There was a problem with authentication".

## Upgrading SurrealDB

Images are pinned by tag **and** digest in `base/kustomization.yaml`. In a PR: read the release
notes, take a backup, update both tag and digest, apply to dev first.

## Not done yet

- PVC snapshots (a GKE VolumeSnapshot schedule) as a second backup layer.
- The nightly clean-up job (D38 retention, idempotency-key expiry), running as the migrator.
