# SurrealDB on Kubernetes

Single-node SurrealDB **v3.2.4** on RocksDB with a persistent disk, packaged with Kustomize
("Option A" in the project doc `context/research/surrealdb-kubernetes-options.html`, which also
explains the Kubernetes terms used here).

```
base/                     shared by every environment
  statefulset.yaml        1 pod + disk; never more than 1 (RocksDB is single-writer);
                          fsync on every commit (SURREAL_DATASTORE_SYNC_DATA=every);
                          runs the init script at every start (--import-file); the
                          identity-check sidecar gates readiness (identity_check.py)
  service.yaml            internal name surrealdb.database.svc; never public
  networkpolicy.yaml      deny all inbound, except pods in this namespace labelled
                          heisreal.today/db-client=true (the migrate and backup Jobs)
  init.surql.tmpl         startup init: namespace/database, system users, service logins;
                          passwords filled in from Secret Manager; one transaction
  identity_check.py       readiness: the intended credentials work (D13 B)
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
| `root`                    | root OWNER         | `surreal-root-password`            | people only (restore drill, rotation) |

**The init runs inside SurrealDB, at every start** (`surreal start --import-file`, from the
`surrealdb-init-<hash>` Secret). It defines `migrator` and `backup`, **removes** the old
per-service system users (`api_read`, `api_write`, `api_admin`, `workflow`: an EDITOR could
`REMOVE EVENT`), and writes each service's argon2 hash with `crypto::argon2::generate`, so only
the hash is stored. The plaintext stays in that Secret (rendered in-cluster by ESO): never in
Terraform state, the repo, the migration bundle or logs.

Why at startup and not a Job: on 3.2.4, removing a user **doesn't end its open sessions** (an
EDITOR session kept reading `PERMISSIONS NONE` tables; pinned by a test). A restart does, and the
server answers nothing (503) until the import has finished, so nobody can sign in in between.
Terraform names the ExternalSecret, its Secret and the template ConfigMap after a hash of the
template, the ExternalSecret definitions and the gcp root's `secret_rotation`, and stamps the hash
on the pod (`heisreal.today/identity-config`). A change therefore restarts SurrealDB once, and the
new pod can only start when ESO has rendered the new Secret: never with a stale script. Dev cost:
a pod restart (seconds of downtime) whenever the identity config changes (D43).

**Fail closed.** Everything after `USE` in the init is one transaction with the identity marker
(`_identity:current`) written last, so a runtime or syntax error keeps every previous user, hash
and marker (tested). But SurrealDB serves even after a failed import, and `/health` is 200
throughout, so readiness comes from the **identity-check sidecar** (cloud-sdk image, already
pinned; the SurrealDB image has no shell for an exec probe). Its readiness probe signs in as
`migrator` and `backup` with their current passwords, checks the system users are exactly those
two, checks each service's stored hash against its current password (and signs in through `svc`
once the schema defines it), and checks the marker equals the expected hash (Secret key
`identity-hash`). Only then is the pod Ready, so a database with wrong identities drops out of
DNS: services, backups and the migrate Job can't reach it. On success it records
`_identity:verified`, which the migrate Job waits for (it never needs a service password). It
prints reasons, never a password. Another 3.2.4 quirk: a startup file with `OPTION IMPORT` hangs
the server.

Check it: `kubectl -n database get pod surrealdb-0` (READY 2/2) and
`kubectl -n database describe pod surrealdb-0` (a failing probe's reason is in the events).

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
kubectl -n database wait --for=condition=complete job/surrealdb-migrate --timeout=600s
kubectl -n database port-forward svc/surrealdb 8000:8000   # apps use ws://localhost:8000
```

- Stop/start without deleting anything: `pnpm nx run surrealdb-k8s:local-down` / `local-up`.
- The pod waits for the `surrealdb-init` Secret, so run `local-secrets.mjs` first.
- After passwords are rotated or `init.surql.tmpl` changes, re-run `local-secrets.mjs` and
  `kubectl -n database rollout restart statefulset/surrealdb` (the init runs at startup).
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
`migrator`. The hash covers every file, the Terraform parameters (DPA hashes, Clerk key, identity
config) and the Job spec: change any of them and the next apply replaces the Job, which runs;
change nothing and there's no diff. The Job doesn't retry on its own (`backoffLimit: 0`).

The runner uses the `google/cloud-sdk` image (already pinned for backups): the SurrealDB image has
no shell, and `surreal import` requires `OPTION IMPORT`, which switches off events and field
rules, so data scripts would bypass the schema.

What a run does, in order (validate first, then change):

1. **Waits** until the identity-check sidecar has verified the current identity config
   (`_identity:verified`), the system users are exactly `backup` and `migrator`, and every
   service has a login.
2. **Takes a fencing token** from the database (`_migrationRun:lock`, incremented in a
   transaction). Every later step checks the token is still the newest and writes the lock row,
   so a run that started later always wins and an older one fails at its next check or commit.
   A rollback to an older bundle is just a newer run.
3. **Checks, read-only:** every file follows the grammar (below); no step was left unfinished
   (`_migrationPending`); no applied data script has changed (sha256 in `_migration`); no pending
   script needs a parameter Terraform passed as null; every seeded DPA version still has its file
   and a published one's text hasn't changed (`dpa-sync.surql` in a cancelled transaction).
4. **Schema:** `schema.surql` and the Clerk access, one step.
5. **Data scripts:** each new one, one step each, recorded in `_migration`.
6. **DPA sync:** draft hashes follow their files, one step.

Each **step** is: commit a `_migrationPending:<step>` row, run one transaction for the step
(ending with its `_migration` row, for data scripts, and then `RETURN '<fresh random nonce>'`),
and only then delete the pending row in a separate statement, once the runner has checked that
the nonce came back as the last result before a successful `COMMIT`, every statement answered
OK, the result count matches, and (data scripts) the `_migration` row is really there. Anything
that ends the transaction early, however it got past the grammar, means the nonce never comes
back. Nothing in the step itself can clear its pending row. A rollback is never
assumed either: only when the server refuses the step's `COMMIT` (an aborted transaction or a
write conflict) does the runner report a rollback and clear the row (exit 1). Anything else (a
short result count, a failed statement in a committed transaction, no answer) leaves the row:
exit 3, and **every later run refuses to start** until someone has checked the data and cleared
the row. A `_migration` row is no proof on its own: the pending row decides.

**Grammar** (refused before anything runs, exit 2). It is an **allow-list**, because 3.2.4 has
several ways to skip statements silently: a `RETURN` anywhere in a transaction ends it early
(`[RETURN 1]`, `1 + RETURN 1`, `IF … THEN RETURN … END`, blocks), and `BREAK`/`CONTINUE` in an
`IF` or `FOR` block skip the rest of the block while the transaction, and the marker after it,
still commit. So, in data scripts and `dpa-sync.surql`:

- every statement, at the top level and inside `IF` / `ELSE` / `FOR` blocks, starts with one of
  `CREATE`, `UPDATE`, `UPSERT`, `DELETE`, `LET`, `IF`, `FOR`, `THROW`, `SELECT` (what the seeds
  and the sync need; add one only with a test);
- these words may not appear anywhere outside strings and comments: `RETURN`, `BREAK`,
  `CONTINUE`, `BEGIN`, `COMMIT`, `CANCEL`, `OPTION`, `SLEEP`, `USE`, `DEFINE`, `REMOVE`,
  `ALTER`, `INFO`, `KILL`, `LIVE`, and `THEN`/`END` (use brace blocks);
- a `;` anywhere else (a block the runner can't classify) is refused.

Outside string literals the runner only accepts what it can lex exactly: ASCII letters, digits,
`_`, whitespace and `; , . : ( ) { } [ ] = ! < > + - * $ ?` (the schema also `|`). So no `/`
(regex literals like `/'/` can hold quotes; no division either), `\`, `@`, `%`, `&`, and no
prefixed strings (`r"…"`, `u'…'`, `d'…'`, `b"…"`, `s'…'`): write a record link as `table:id` and
cast with `<datetime>` / `<uuid>` instead.

The files must also be plain text the runner fully understands: control, format and line or paragraph
separator characters (e.g. U+0085, U+2028, U+2029, NUL, VT, FF) are refused anywhere, strings
included, because SurrealDB ends comments at some of them; outside string literals (comments
included) only printable ASCII, TAB, CR and LF are allowed; backtick and `⟨⟩` identifiers may not
contain backslashes or line breaks. Non-ASCII text (e.g. `’`) is fine inside `'…'`/`"…"` strings.

Each allowed form and each refused word is tested on 3.2.4 at the top level, in an `IF` and in a
`FOR` (`libs/database/integration`, "allow-list"). `schema.surql` and `access-clerk.surql` are DDL
only (`DEFINE`/`REMOVE`), with `RETURN`/`BREAK`/`CONTINUE` only inside a `DEFINE` (tested:
function, event, field and param bodies can't end or skip the caller's transaction), and no
`BEGIN`/`COMMIT`/`CANCEL` or `OPTION` statement. Also avoid `FOR $x IN (SELECT …)` and bare record
paths like `table:id.field` inside `IF` (both fail on 3.2.4; `LET` the value first).

**Threat model.** Data scripts are reviewed repository code; these guards protect against
mistakes in them, not against a hostile author. The acknowledgement makes the guarantee
independent of the scanner for every early exit that ends the transaction; `BREAK` and
`CONTINUE`, which only skip within a block, are covered by the token ban.

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

   The summary lists what was `applied` and `alreadyApplied`, and the run's `token`. While the
   identity config isn't verified yet (SurrealDB restarting, or a failed init), the log shows
   `waiting for the startup init's identities`; check `kubectl -n database get pod surrealdb-0`.

3. Then apply `gcp` to deploy the services that need the new schema.

**If it fails**, read `kubectl -n database logs job/<name>` (and `describe job/<name>`). The
`ERROR:` line names the step. Don't deploy services that need the new schema until a run succeeds.

- **Exit 2 (bundle) or a failed check** (`gave up waiting…`, `changed after it was applied`,
  `passed as null`, `does not: restore the file`, `is published, but…`, `superseded`):
  **nothing was changed**. Fix the cause and apply again.
- **Exit 1, `schema:` failed** (the message says the server refused the step's `COMMIT`): rolled
  back, confirmed; the previous schema and all data are as before.
- **Exit 1, a data script (`NNNN-…:`) or `dpa-sync:` failed** (same confirmation): that step was
  rolled back, but the **new schema is in place**, and so is every data script before it. Recover **forward**: fix the
  script in a PR (it never ran, so editing it is fine; never edit one that has run anywhere, add
  a new one) and apply. Running services must cope with the new schema, which is why a breaking
  change is split over two releases.
- **Exit 3, `PARTIAL COMMIT POSSIBLE` or `blocked: unfinished step(s)`:** a step may have
  committed partly, and migrations stop until you've looked. Port-forward and sign in as the
  migrator (password from Secret Manager), then:

  ```sql
  SELECT record::id(id) AS step, token, startedAt FROM _migrationPending;
  SELECT record::id(id), appliedAt FROM _migration ORDER BY id;
  ```

  Don't assume the step rolled back, and don't take a `_migration` row as proof it completed:
  check. Compare the step's script with the data (which of its writes landed?). If its
  `_migration` row is missing, undo what it wrote, or complete it and add the row yourself; if the
  row is there, make sure every write landed (complete it, or with a new data script). Only then
  `DELETE _migrationPending:⟨<step>⟩;` and apply again. A row whose step simply succeeded but whose
  runner died before clearing it looks the same: the `_migration` row is there and the data is
  complete. A row can also be left by a run that was killed mid-step (e.g. a Spot reclaim);
  check the same way.

See what ran either way: the log's `applied` lines, or the `_migration` query above. A fixed
bundle has a new hash, so a new Job runs. To re-run the same bundle, apply with
`-replace='module.cluster.kustomization_resource.migrate'`.

**Adding a data script:** `libs/database/schema/data/NNNN-what-it-does.surql`, next number,
plain statements in the grammar above. The runner wraps each script in its own transaction and
records it in `_migration` with a checksum. Add tests in `libs/database/integration`.

**Clerk key** (task 0.5): Clerk's PEM public key is in
`infra/terraform/live/dev/cluster/clerk.auto.tfvars` (the dev instance's; how to get it:
`infra/clerk/README.md`). Empty, the migration removes `DEFINE ACCESS clerk`, so no token can open
a person session. Never a private key (the variable refuses one). After a Clerk key rotation,
update it here and in the services' `CLERK_JWT_PUBLIC_KEY`, then migrate.

**DPA text** (D20): Terraform passes each `libs/legal/dpa/*.md` file's sha256 (`$dpa_sha256`).
While a version is a draft, its `contentHash` follows the file; once published, a changed file
fails the migration. Every seeded version, draft or published, must keep its file: a missing one
fails the migration (only a version that isn't seeded yet may lack it). A version created through
api-admin needs its file committed before the next migration.

**First apply of this (one-time switch to service logins).** The services' new secrets must
exist before SurrealDB's new init Secret can be rendered (until then the restarted pod waits, so
SurrealDB is down), and the deployed api-public-read signs in as the old `api_read` user until
it's redeployed:

1. Wait for "Release Images" to build `main` (libs/database now signs in through `svc`).
2. `gcp`: `terraform apply -target='module.gcp.google_secret_manager_secret_version.surreal' -target='module.gcp.google_secret_manager_secret_iam_member.surrealdb_secrets'`
   creates `surreal-api-public-read-password` and `surreal-api-user-password` and gives ESO
   access.
3. `cluster`: apply. It deletes the old init Job, applies `surrealdb-init-<hash>`, restarts
   SurrealDB (the cutover: old users removed, their sessions ended) and runs
   the migrate Job, which waits for the sidecar's verification; check both as above. Dev's
   api-public-read can't sign in from here until step 4.
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

- **Services, migrator and backup:** bump `secret_rotation` in the gcp root and apply, then apply
  the cluster root. The cluster root reads the rotation number, so the identity hash changes:
  a new ExternalSecret fetches the latest versions, SurrealDB restarts with them (ending every
  session that used an old password), the identity-check sidecar keeps the pod un-Ready until
  the new passwords work, and the migrate Job runs once it's verified. If the init fails, the old
  passwords stay valid and the pod stays un-Ready: look at the pod's events. Finally restart the
  services, which read their secret at startup.
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

  Nothing in the cluster signs in as root (the init runs inside the server), so only people
  notice a stale root password.

## Upgrading SurrealDB

Images are pinned by tag **and** digest in `base/kustomization.yaml`. In a PR: read the release
notes, take a backup, update both tag and digest, apply to dev first.

## Not done yet

- PVC snapshots (a GKE VolumeSnapshot schedule) as a second backup layer.
- The nightly clean-up job (D38 retention, idempotency-key expiry), running as the migrator.
