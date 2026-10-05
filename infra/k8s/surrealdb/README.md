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
                          heisreal.today/db-client=true (the init and backup Jobs)
  init-users-job.yaml     creates namespace/database + one user per service (re-runnable)
  init.surql.tmpl         the user definitions; passwords filled in from Secret Manager
  backup-cronjob.yaml     nightly `surreal export` → Cloud Storage
overlays/local/           kind/k3d/minikube: 1 GiB disk, no backups
overlays/gke/             External Secrets Operator, Workload Identity, SSD disk
overlays/gke-dev/         dev values (settings.env, checked against Terraform), Spot Pods, small
                          requests, 5 GiB balanced disk, Cloud Run subnet allowed in, quota
scripts/local-secrets.mjs creates a local cluster's Secrets from the dev project via gcloud
```

## Database users

Database-level users in `heisreal/main`, each with its own Secret Manager secret
(`surreal-<user>-password`, dashes for underscores):

| User        | Role   | Used by                               |
| ----------- | ------ | ------------------------------------- |
| `api_read`  | VIEWER | api-read                              |
| `api_write` | EDITOR | api-write                             |
| `api_admin` | EDITOR | api-admin                             |
| `workflow`  | EDITOR | workflow (M7)                         |
| `backup`    | VIEWER | backup CronJob                        |
| `migrator`  | OWNER  | schema migrations at deploy time only |
| `root`      | OWNER  | init Job only (root user)             |

Checked against a real 3.2.4 server: VIEWER can't create records, EDITOR can't define users, and
a VIEWER export equals a root export (backups need no write access). Exports include every user's
password hash; the passwords are 40 random characters, so the hashes aren't crackable in practice.

## Run it locally

You need a local cluster (kind, k3d or minikube), `kubectl`, and `gcloud` logged in to
`heisreal-dev`.

```bash
node infra/k8s/surrealdb/scripts/local-secrets.mjs --project heisreal-dev   # local clusters only
kubectl apply -k infra/k8s/surrealdb/overlays/local
kubectl -n database rollout status statefulset/surrealdb
kubectl -n database wait --for=condition=complete job/surrealdb-init-users --timeout=180s
kubectl -n database port-forward svc/surrealdb 8000:8000   # apps use ws://localhost:8000
```

- Stop/start without deleting anything: `pnpm nx run surrealdb-k8s:local-down` / `local-up`.
- The first one or two init Job runs fail with a DNS error: `surrealdb` only resolves once the pod
  is ready, and the Job retries until then.
- After passwords are rotated, re-run `local-secrets.mjs`, delete `job/surrealdb-init-users` and
  re-apply the overlay (for root, see "Rotating passwords" first).

## Deploy to GKE (Terraform only)

Never `kubectl apply` to GKE. The `cluster` root applies the `gke-dev` overlay; the `gcp` root
owns the cluster, secrets, bucket and identities (see [the Terraform README](../../terraform/README.md)).
Cloud Run reaches SurrealDB at `surrealdb.database.svc.cluster.heisreal-dev.internal:8000`
through VPC-scope DNS, with no load balancer.

`settings.env` repeats a few Terraform values (project, bucket, service accounts, Cloud Run
subnet) so the overlay renders on its own; the `cluster` root refuses to plan if they differ.

Set `storageClassName` and the disk size **before the first deploy**: a StatefulSet can't change
them afterwards (disks can be grown by editing the PVC).

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

- **Service users:** bump `secret_rotation` in the gcp root and apply. ESO syncs within an hour
  (annotate the ExternalSecret `surrealdb-init` with `force-sync=$(date +%s)` to hurry it). Then
  apply the cluster root: the init Job is recreated on every apply and sets the new passwords
  (`DEFINE USER OVERWRITE`). Finally restart the services, which read their secret at startup.
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
- Schema (M0 task 0.3), applied by the `migrator` user.
